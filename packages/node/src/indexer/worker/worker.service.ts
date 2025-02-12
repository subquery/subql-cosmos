// // Copyright 2020-2025 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import { threadId } from 'node:worker_threads';
import { Inject, Injectable } from '@nestjs/common';
import {
  NodeConfig,
  getLogger,
  IProjectService,
  ProcessBlockResponse,
  BaseWorkerService,
  IProjectUpgradeService,
  IBlock,
  Header,
} from '@subql/node-core';
import { CosmosDatasource } from '@subql/types-cosmos';
import { cosmosBlockToHeader } from '../../utils/cosmos';
import { ApiService } from '../api.service';
import { IndexerManager } from '../indexer.manager';
import { BlockContent, getBlockSize } from '../types';

export type FetchBlockResponse = Header;

export type WorkerStatusResponse = {
  threadId: number;
  isIndexing: boolean;
  fetchedBlocks: number;
  toFetchBlocks: number;
};

const logger = getLogger(`Worker Service #${threadId}`);

@Injectable()
export class WorkerService extends BaseWorkerService<
  BlockContent,
  FetchBlockResponse,
  CosmosDatasource
> {
  constructor(
    private apiService: ApiService,
    private indexerManager: IndexerManager,
    @Inject('IProjectService')
    projectService: IProjectService<CosmosDatasource>,
    @Inject('IProjectUpgradeService')
    projectUpgradeService: IProjectUpgradeService,
    nodeConfig: NodeConfig,
  ) {
    super(projectService, projectUpgradeService, nodeConfig);
  }

  protected async fetchChainBlock(
    heights: number,
    extra: {},
  ): Promise<IBlock<BlockContent>> {
    const [block] = await this.apiService.fetchBlocks([heights]);

    return block;
  }

  protected toBlockResponse(block: BlockContent): FetchBlockResponse {
    return cosmosBlockToHeader(block.block.header);
  }

  protected async processFetchedBlock(
    block: IBlock<BlockContent>,
    dataSources: CosmosDatasource[],
  ): Promise<ProcessBlockResponse> {
    return this.indexerManager.indexBlock(block, dataSources);
  }

  getBlockSize(block: IBlock<BlockContent>): number {
    return getBlockSize(block.block);
  }
}
