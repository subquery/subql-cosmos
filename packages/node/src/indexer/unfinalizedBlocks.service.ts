// // Copyright 2020-2025 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import { Inject, Injectable } from '@nestjs/common';
import {
  BaseUnfinalizedBlocksService,
  Header,
  NodeConfig,
  IStoreModelProvider,
  mainThreadOnly,
} from '@subql/node-core';
import { cosmosBlockToHeader } from '../utils/cosmos';
import { ApiService } from './api.service';
import { BlockContent } from './types';

@Injectable()
export class UnfinalizedBlocksService extends BaseUnfinalizedBlocksService<BlockContent> {
  constructor(
    private readonly apiService: ApiService,
    nodeConfig: NodeConfig,
    @Inject('IStoreModelProvider') storeModelProvider: IStoreModelProvider,
  ) {
    super(nodeConfig, storeModelProvider);
  }

  @mainThreadOnly()
  protected async getFinalizedHead(): Promise<Header> {
    return this.getHeaderForHeight(await this.apiService.api.getHeight());
  }

  @mainThreadOnly()
  protected async getHeaderForHash(hash: string): Promise<Header> {
    return this.getHeaderForHeight(parseInt(hash, 10));
  }

  @mainThreadOnly()
  async getHeaderForHeight(height: number): Promise<Header> {
    return Promise.resolve(cosmosBlockToHeader(height));
  }
}
