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
import { BlockContent } from '../../indexer/types';
import { KyveApi, KyveConnectionConfig } from './kyve';

const logger = getLogger('kyve-API');

type KyveFetchFunc = (
  registry: Registry,
  batch: number[],
) => Promise<BlockContent[]>;

export class KyveConnection
  implements IApiConnectionSpecific<KyveApi, undefined, BlockContent[]>
{
  unsafeApi: any;
  readonly networkMeta: NetworkMetadataPayload;

  private constructor(
    private fetchBlocksBatches: KyveFetchFunc,
    private chainId: string,
    private registry: Registry,
  ) {
    this.networkMeta = {
      chain: this.chainId,
      specName: undefined,
      genesisHash: undefined,
    };
  }

  static async create(
    chainId: string,
    registry: Registry,
    kyveConfig: KyveConnectionConfig,
  ): Promise<KyveConnection> {
    const kyveApi = await KyveApi.create(chainId, kyveConfig);

    const connection = new KyveConnection(
      kyveApi.fetchBlocksBatches.bind(kyveApi),
      chainId,
      registry,
    );

    logger.info(`connected to Kyve via ${kyveConfig.storageUrl}`);

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
    //
  }

  async apiDisconnect(): Promise<void> {
    //
  }
}
