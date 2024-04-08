// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import { Registry } from '@cosmjs/proto-signing';
import { SupportedChains } from '@kyvejs/sdk/src/constants';
import {
  ApiConnectionError,
  ApiErrorType,
  getLogger,
  IApiConnectionSpecific,
  NetworkMetadataPayload,
} from '@subql/node-core';
import { CosmosClient } from '../../indexer/api.service';
import { CosmosClientConnection } from '../../indexer/cosmosClient.connection';
import { BlockContent } from '../../indexer/types';
import { KyveApi } from './kyve';

const logger = getLogger('kyve-API');

type KyveFetchFunc = (
  registry: Registry,
  batch: number[],
) => Promise<BlockContent[]>;

export class KyveConnection
  implements IApiConnectionSpecific<CosmosClient, undefined, BlockContent[]>
{
  unsafeApi: CosmosClient;
  readonly networkMeta: NetworkMetadataPayload;

  private constructor(
    private fetchBlocksBatches: KyveFetchFunc,
    chainId: string,
    private registry: Registry,
    cosmosClient: CosmosClientConnection,
  ) {
    this.networkMeta = {
      chain: chainId,
      specName: undefined,
      genesisHash: undefined,
    };
    this.unsafeApi = cosmosClient.unsafeApi;
  }

  static async create(
    endpoint: string, // kyve LCD Endpoint
    chainId: string,
    registry: Registry,
    storageUrl: string,
    kyveChainId: SupportedChains,
    cosmosClient: CosmosClientConnection,
    tmpCacheDir: string,
  ): Promise<KyveConnection> {
    const kyveApi = await KyveApi.create(
      chainId,
      endpoint,
      storageUrl,
      kyveChainId,
      tmpCacheDir,
    );

    const connection = new KyveConnection(
      kyveApi.fetchBlocksBatches.bind(kyveApi),
      chainId,
      registry,
      cosmosClient,
    );

    logger.info(`connected to Kyve via ${endpoint}`);

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

  safeApi(height: number): any {
    throw new Error('SafeApi should not be used for kyve-connection');
  }

  async apiConnect(): Promise<void> {
    return Promise.resolve();
  }

  async apiDisconnect(): Promise<void> {
    return Promise.resolve();
  }
}
