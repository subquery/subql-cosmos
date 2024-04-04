// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import { Registry } from '@cosmjs/proto-signing';
import {
  ApiConnectionError,
  ApiErrorType,
  getLogger,
  IApiConnectionSpecific,
  NetworkMetadataPayload,
} from '@subql/node-core';
import { FetchFunc } from '../../indexer/cosmosClient.connection';
import { BlockContent } from '../../indexer/types';
import { KyveApi } from './kyve';

const logger = getLogger('kyve-API');

export class KyveConnection
  implements IApiConnectionSpecific<KyveApi, undefined, BlockContent[]>
{
  readonly networkMeta: NetworkMetadataPayload; // this is not needed
  unsafeApi: any; // this isnt needed
  private registry: Registry;

  constructor(
    private fetchBlocksBatches: FetchFunc,
    private chainId: string,
  ) // todo do i need registry ?
  {
    this.networkMeta = {
      chain: this.chainId,
      specName: undefined,
      genesisHash: undefined,
    };
  }

  static async create(
    chainId: string,
    kyveEndpoint: string,
    registry: Registry,
  ): Promise<KyveConnection> {
    const kyveApi = new KyveApi(chainId, kyveEndpoint);
    await kyveApi.init();

    const connection = new KyveConnection(
      kyveApi.fetchBlocksBatches.bind(kyveApi),
      chainId,
    );
    connection.setRegistry(registry);

    logger.info(`connected to Kyve via ${kyveEndpoint}`);

    return connection;
  }

  async fetchBlocks(heights: number[]): Promise<BlockContent[]> {
    const blocks = await this.fetchBlocksBatches(this.registry, heights);
    return blocks;
  }

  handleError = KyveConnection.handleError;

  static handleError(error: Error): ApiConnectionError {
    return new ApiConnectionError(
      'KyveError',
      error.message,
      ApiErrorType.Default,
    );
  }

  private setRegistry(registry: Registry): void {
    this.registry = registry;
  }

  // No safeAPi
  safeApi(height: number): any {
    return undefined;
  }

  async apiConnect(): Promise<void> {
    return Promise.resolve(undefined);
  }

  async apiDisconnect(): Promise<void> {
    return Promise.resolve(undefined);
  }
}
