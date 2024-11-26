// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import { Inject, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SchedulerRegistry } from '@nestjs/schedule';
import {
  isCustomCosmosDs,
  CosmosHandlerKind,
  CosmosDataSource,
} from '@subql/common-cosmos';
import {
  NodeConfig,
  BaseFetchService,
  getModulos,
  Header,
  IStoreModelProvider,
} from '@subql/node-core';
import * as CosmosUtil from '../utils/cosmos';
import { cosmosBlockToHeader } from '../utils/cosmos';
import { ApiService, CosmosClient } from './api.service';
import { ICosmosBlockDispatcher } from './blockDispatcher';
import { DictionaryService } from './dictionary/dictionary.service';
import { ProjectService } from './project.service';
import { BlockContent } from './types';
import { UnfinalizedBlocksService } from './unfinalizedBlocks.service';

const BLOCK_TIME_VARIANCE = 5000; //ms
const INTERVAL_PERCENT = 0.9;

@Injectable()
export class FetchService extends BaseFetchService<
  CosmosDataSource,
  ICosmosBlockDispatcher,
  BlockContent
> {
  constructor(
    private apiService: ApiService,
    nodeConfig: NodeConfig,
    @Inject('IProjectService') projectService: ProjectService,
    @Inject('IBlockDispatcher')
    blockDispatcher: ICosmosBlockDispatcher,
    dictionaryService: DictionaryService,
    unfinalizedBlocksService: UnfinalizedBlocksService,
    eventEmitter: EventEmitter2,
    schedulerRegistry: SchedulerRegistry,
    @Inject('IStoreModelProvider') storeModelProvider: IStoreModelProvider,
  ) {
    super(
      nodeConfig,
      projectService,
      blockDispatcher,
      dictionaryService,
      eventEmitter,
      schedulerRegistry,
      unfinalizedBlocksService,
      storeModelProvider,
    );
  }

  get api(): CosmosClient {
    return this.apiService.unsafeApi;
  }

  protected async getFinalizedHeader(): Promise<Header> {
    // Cosmos has instant finalization
    const height = await this.api.getHeight();
    return cosmosBlockToHeader(height);
  }

  protected async getBestHeight(): Promise<number> {
    return this.api.getHeight();
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  protected async getChainInterval(): Promise<number> {
    const chainInterval = CosmosUtil.calcInterval(this.api) * INTERVAL_PERCENT;

    return Math.min(BLOCK_TIME_VARIANCE, chainInterval);
  }

  protected getModulos(dataSources: CosmosDataSource[]): number[] {
    return getModulos(dataSources, isCustomCosmosDs, CosmosHandlerKind.Block);
  }

  protected async initBlockDispatcher(): Promise<void> {
    await this.blockDispatcher.init(this.resetForNewDs.bind(this));
  }

  protected async preLoopHook(): Promise<void> {
    // Cosmos doesn't need to do anything here
    return Promise.resolve();
  }
}
