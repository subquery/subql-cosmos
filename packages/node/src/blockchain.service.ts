// // Copyright 2020-2025 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import assert from 'node:assert';
import { Inject } from '@nestjs/common';
import {
  CosmosRuntimeDataSourceImpl,
  isCustomCosmosDs,
  isCustomDs,
  isRuntimeCosmosDs,
  isRuntimeDs,
} from '@subql/common-cosmos';
import {
  DatasourceParams,
  Header,
  IBlock,
  IBlockchainService,
} from '@subql/node-core';
import {
  CosmosCustomDatasource,
  CosmosCustomHandler,
  CosmosDatasource,
  CosmosHandlerKind,
  CosmosMapping,
} from '@subql/types-cosmos';
import { plainToClass, ClassConstructor } from 'class-transformer';
import { validateSync, IsOptional, IsObject } from 'class-validator';
import { SubqueryProject } from './configure/SubqueryProject';
import { ApiService, CosmosSafeClient } from './indexer/api.service';
import { BlockContent } from './indexer/types';
import { IIndexerWorker } from './indexer/worker/worker';
import {
  cosmosBlockToHeader,
  getBlockTimestamp,
  calcInterval,
} from './utils/cosmos';

const { version: packageVersion } = require('../package.json');

const BLOCK_TIME_VARIANCE = 5000; //ms
const INTERVAL_PERCENT = 0.9;

class DataSourceArgs {
  @IsOptional()
  @IsObject()
  values?: Record<string, string>;

  @IsOptional()
  @IsObject()
  attributes?: Record<string, string>;
}

export class BlockchainService
  implements
    IBlockchainService<
      CosmosDatasource,
      CosmosCustomDatasource,
      SubqueryProject,
      CosmosSafeClient,
      BlockContent,
      BlockContent,
      IIndexerWorker
    >
{
  blockHandlerKind = CosmosHandlerKind.Block;
  isCustomDs = isCustomDs;
  isRuntimeDs = isRuntimeDs;
  packageVersion = packageVersion;

  constructor(@Inject('APIService') private apiService: ApiService) {}

  async fetchBlocks(blockNums: number[]): Promise<IBlock<BlockContent>[]> {
    return this.apiService.fetchBlocks(blockNums);
  }

  async fetchBlockWorker(
    worker: IIndexerWorker,
    blockNum: number,
    context: { workers: IIndexerWorker[] },
  ): Promise<Header> {
    return worker.fetchBlock(blockNum, 0);
  }

  getBlockSize(block: IBlock): number {
    throw new Error('Method not implemented.');
  }

  async getFinalizedHeader(): Promise<Header> {
    const height = await this.apiService.unsafeApi.getHeight();
    const blockInfo = await this.apiService.unsafeApi.blockInfo(height);
    return cosmosBlockToHeader(blockInfo.block.header);
  }

  async getBestHeight(): Promise<number> {
    return this.apiService.unsafeApi.getHeight();
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getChainInterval(): Promise<number> {
    const chainInterval =
      calcInterval(this.apiService.unsafeApi) * INTERVAL_PERCENT;

    return Math.min(BLOCK_TIME_VARIANCE, chainInterval);
  }

  async getHeaderForHash(hash: string): Promise<Header> {
    // Height is used as hash for cosmos
    return this.getHeaderForHeight(parseInt(hash, 10));
  }

  async getHeaderForHeight(height: number): Promise<Header> {
    const block = await this.apiService.unsafeApi.blockInfo(height);
    return cosmosBlockToHeader(block.block.header);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async updateDynamicDs(
    params: DatasourceParams,
    dsObj: CosmosDatasource | CosmosCustomDatasource,
  ): Promise<void> {
    if (isCustomCosmosDs(dsObj)) {
      dsObj.processor.options = {
        ...dsObj.processor.options,
        ...params.args,
      };
      // await this.dsProcessorService.validateCustomDs([dsObj]);
    } else if (isRuntimeCosmosDs(dsObj)) {
      const { args } = params;
      if (!args) {
        throw new Error('Expected args to be defined');
      }
      validateType(DataSourceArgs, args, 'Dynamic ds args are invalid');

      dsObj.mapping.handlers = dsObj.mapping.handlers.map((handler) => {
        switch (handler.kind) {
          case CosmosHandlerKind.Event:
            assert(
              handler.filter,
              'Dynamic datasources must have some predfined filter',
            );
            if (args.values) {
              if (!handler.filter.messageFilter) {
                throw new Error(
                  'Cannot set values on handler without predefined messageFilter type',
                );
              }
              handler.filter.messageFilter.values = {
                ...handler.filter.messageFilter.values,
                ...(args.values as Record<string, string>),
              };
            }
            if (args.attributes) {
              handler.filter.attributes = {
                ...handler.filter.attributes,
                ...(args.attributes as Record<string, string>),
              };
            }
            return handler;
          case CosmosHandlerKind.Message:
            assert(
              handler.filter,
              'Dynamic datasources must have some predfined filter',
            );
            if (args.values) {
              if (!handler.filter) {
                throw new Error(
                  'Cannot set values on handler without predefined messageFilter type',
                );
              }
              handler.filter.values = {
                ...handler.filter.values,
                ...(args.values as Record<string, string>),
              };
            }
            return handler;
          case CosmosHandlerKind.Transaction:
          case CosmosHandlerKind.Block:
          default:
            return handler;
        }
      });

      validateType(CosmosRuntimeDataSourceImpl, dsObj, 'Dynamic ds is invalid');
    }
  }

  async getSafeApi(block: BlockContent): Promise<CosmosSafeClient> {
    return this.apiService.getSafeApi(block.block.header.height);
  }

  onProjectChange(project: SubqueryProject): Promise<void> | void {
    // TODO update this when implementing skipBlock feature for Cosmos
    // this.apiService.updateBlockFetching();
  }

  async getBlockTimestamp(height: number): Promise<Date> {
    const response = await this.apiService.api.blockInfo(height);
    return getBlockTimestamp(response.block.header);
  }
}

function validateType<T extends object>(
  classtype: ClassConstructor<T>,
  data: T,
  errorPrefix: string,
) {
  const parsed = plainToClass(classtype, data);

  const errors = validateSync(parsed, {
    whitelist: true,
    forbidNonWhitelisted: false,
  });
  if (errors.length) {
    throw new Error(
      `${errorPrefix}\n${errors.map((e) => e.toString()).join('\n')}`,
    );
  }
}
