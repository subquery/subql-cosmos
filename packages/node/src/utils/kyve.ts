// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import { JsonRpcSuccessResponse } from '@cosmjs/json-rpc';
import { adaptor37 } from '@cosmjs/tendermint-rpc/build/tendermint37/adaptor';
import {
  BlockResponse,
  BlockResultsResponse,
} from '@cosmjs/tendermint-rpc/build/tendermint37/responses';
// Currently these types are not exported
import { Gzip } from '@kyvejs/protocol/dist/src/reactors/compression/Gzip';
import { Arweave } from '@kyvejs/protocol/dist/src/reactors/storageProviders/Arweave';
import { Bundlr } from '@kyvejs/protocol/dist/src/reactors/storageProviders/Bundlr';
import KyveSDK, { KyveLCDClientType } from '@kyvejs/sdk';
import { SupportedChains } from '@kyvejs/sdk/src/constants';

const BUNDLE_TIMEOUT = 100000; //ms

interface UnZippedKyveBlockReponse {
  value: { block: any; block_results: any };
  key: string;
}

export class KyveApi {
  private lcdClient: KyveLCDClientType;
  private respAdaptor = adaptor37.responses;
  private poolId: string;
  private currentBundleId: number;
  private cachedBlocks: UnZippedKyveBlockReponse[];

  constructor(
    private chainId: string,
    kyveChainId: SupportedChains = 'kyve-1',
  ) {
    this.lcdClient = new KyveSDK(kyveChainId).createLCDClient();
  }
  async init(): Promise<void> {
    this.currentBundleId = 0;
    await this.setPoolId();
  }
  private async getAllPools() {
    return this.lcdClient.kyve.query.v1beta1.pools();
  }

  private async setPoolId(): Promise<void> {
    const pools = await this.getAllPools();
    const pool = pools.pools.find(
      (p) => JSON.parse(p.data.config).network === this.chainId,
    );
    if (!pool) {
      throw new Error(`${this.chainId} is not available on Kyve network`);
    }
    this.poolId = pool.id;
  }

  private async retrieveBundleData(
    bundleResponse: any,
  ): Promise<{ storageId: string; storageData: any }> {
    const { storage_id, storage_provider_id } = bundleResponse;
    switch (parseInt(storage_provider_id) ?? 0) {
      case 0:
        throw new Error('No storage, no existing stored data');
      case 1:
        return new Arweave('1').retrieveBundle(storage_id, BUNDLE_TIMEOUT);
      case 2:
        return new Bundlr('1').retrieveBundle(storage_id, BUNDLE_TIMEOUT);
      default:
        throw new Error('Unsupported storage provider');
    }
  }

  private async unzipStorageData(
    compressionId: string,
    storageData: any,
  ): Promise<UnZippedKyveBlockReponse[]> {
    const g = new Gzip();
    if (parseInt(compressionId) === 0) {
      throw new Error('No Compression');
    }

    const buffer = await g.decompress(storageData);
    const parsedString = buffer.toString('utf-8');

    return JSON.parse(parsedString);
  }

  private decodeBlock(block: JsonRpcSuccessResponse): BlockResponse {
    return this.respAdaptor.decodeBlock({
      id: 10, // todo
      jsonrpc: '2.0',
      result: block,
    });
  }

  private decodeBlockResult(
    blockResult: JsonRpcSuccessResponse,
  ): BlockResultsResponse {
    return this.respAdaptor.decodeBlockResults({
      id: 10,
      jsonrpc: '2.0',
      result: blockResult,
    });
  }

  private async getBundleById(bundleId: number): Promise<any> {
    return this.lcdClient.kyve.query.v1beta1.finalizedBundle({
      pool_id: this.poolId,
      id: bundleId.toString(),
    });
  }

  private async getLatestBundleId(): Promise<number> {
    return (
      parseInt(
        (
          await this.lcdClient.kyve.query.v1beta1.finalizedBundles({
            pool_id: this.poolId,
            index: '1',
            pagination: {
              limit: '1',
            },
          })
        ).pagination.total,
      ) - 1
    ); // bundle id starts from 0
  }

  private async getBundleId(height: number): Promise<number> {
    const latestBundleId = await this.getLatestBundleId();

    let low = this.currentBundleId;
    let high = latestBundleId;
    let startBundleId = -1; // Initialize to an invalid ID initially

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const midBundle = await this.getBundleById(mid);

      const fromKey = parseInt(midBundle.from_key);
      const toKey = parseInt(midBundle.to_key);

      if (height >= fromKey && height <= toKey) {
        startBundleId = mid;
        this.currentBundleId = startBundleId;
        return startBundleId;
      }

      if (height > toKey) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    throw new Error('No suitable bundle found for the given height.');
  }

  private findBlockByHeight(height: number): UnZippedKyveBlockReponse {
    return this.cachedBlocks.find(
      (bk: UnZippedKyveBlockReponse) => bk.key === height.toString(),
    );
  }

  async getBlockByHeight(
    height: number,
  ): Promise<[BlockResponse, BlockResultsResponse]> {
    console.log('using kyve get block');
    const bundleId = await this.getBundleId(height);
    const rawBundle = await this.getBundleById(bundleId);
    const bundleData = await this.retrieveBundleData(rawBundle);

    if (!this.cachedBlocks) {
      this.cachedBlocks = await this.unzipStorageData(
        rawBundle.compression_id,
        bundleData.storageData,
      );
    }
    const blockData = this.findBlockByHeight(height);

    return [
      this.decodeBlock(blockData.value.block),
      this.decodeBlockResult(blockData.value.block_results),
    ];
  }
}
