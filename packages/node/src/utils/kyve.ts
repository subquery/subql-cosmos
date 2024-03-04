// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import { adaptor37 } from '@cosmjs/tendermint-rpc/build/tendermint37/adaptor';
import {
  BlockResponse,
  BlockResultsResponse,
} from '@cosmjs/tendermint-rpc/build/tendermint37/responses';
import { Gzip } from '@kyvejs/protocol/dist/src/reactors/compression/Gzip';
import { Arweave } from '@kyvejs/protocol/dist/src/reactors/storageProviders/Arweave';
import { Bundlr } from '@kyvejs/protocol/dist/src/reactors/storageProviders/Bundlr';
import KyveSDK, { KyveLCDClientType } from '@kyvejs/sdk';
import { SupportedChains } from '@kyvejs/sdk/src/constants';

const BUNDLE_TIMEOUT = 10000; //ms

export class KyveApi {
  private lcdClient: KyveLCDClientType;
  private respAdaptor = adaptor37.responses;
  private poolId: string;
  private currentBundleId = 1;
  // TODO in memory unzipped blocks

  constructor(
    private chainId: string,
    kyveChainId: SupportedChains = 'kyve-1',
  ) {
    this.lcdClient = new KyveSDK(kyveChainId).createLCDClient();
  }
  async init(): Promise<void> {
    this.currentBundleId = 1; // should be start key provided by the pool
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

  // FinalizedBundle from kyve is not correct
  private async retrieveBundleData(
    bundleResponse: any,
  ): Promise<{ storageId: string; storageData: any }> {
    let data: { storageId: string; storageData: any };
    const { storage_id, storage_provider_id } = bundleResponse;

    if (storage_provider_id === '0') {
      throw new Error('No storage, no existing stored data');
    }

    if (storage_provider_id === '1') {
      // todo temp storage priv
      data = await new Arweave('1').retrieveBundle(storage_id, BUNDLE_TIMEOUT);
    }

    if (storage_provider_id === '2') {
      // todo temp storage priv
      data = await new Bundlr('1').retrieveBundle(storage_id, BUNDLE_TIMEOUT);
    }
    return data;
  }

  private async unzipStorageData(
    compressionId: string,
    storageData: any,
  ): Promise<any> {
    const g = new Gzip();
    if (parseInt(compressionId) === 0) {
      throw new Error('No Compression');
    }

    const buffer = await g.decompress(storageData);
    const parsedString = buffer.toString('utf-8');

    return JSON.parse(parsedString);
  }

  private decodeBlock(block: any) {
    return this.respAdaptor.decodeBlock({
      id: 10,
      jsonrpc: '2.0',
      result: block,
    });
  }

  private decodeBlockResult(blockResult: any) {
    return this.respAdaptor.decodeBlockResults({
      id: 10,
      jsonrpc: '2.0',
      result: blockResult,
    });
  }

  // TODO types
  private async getBundleById(bundleId: string): Promise<any> {
    return this.lcdClient.kyve.query.v1beta1.finalizedBundle({
      pool_id: this.poolId,
      id: bundleId,
    });
  }

  private async getLatestBundleId() {
    // TODO see if there is a better query that can get bundle total
    return (
      await this.lcdClient.kyve.query.v1beta1.finalizedBundles({
        pool_id: this.poolId,
        index: '160', // useless field kyve has wrong typing
        pagination: {
          limit: '1',
        },
      })
    ).pagination.total;
  }

  // TODO should use this for binary search to improve performance
  private async getBundles(key?: string, offset?: string) {
    return this.lcdClient.kyve.query.v1beta1.finalizedBundles({
      pool_id: this.poolId,
      index: '160', // useless field kyve has wrong typing
      pagination: {
        key: key,
        offset: offset,
      },
    });
  }
  private async getBundleId(height: number) {
    // TODO use pagination instead
    const latestBundleId = parseInt(await this.getLatestBundleId());

    let low = this.currentBundleId;
    let high = latestBundleId;
    let startBundleId = -1; // Initialize to an invalid ID initially

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const midBundle = await this.getBundleById(mid.toString()); // You'll need to implement this method

      const fromKey = parseInt(midBundle.from_key);
      const toKey = parseInt(midBundle.to_key);

      if (height > toKey) {
        low = mid + 1;
      } else if (height < fromKey) {
        high = mid - 1;
      } else {
        startBundleId = mid;
        break;
      }
    }

    this.currentBundleId = startBundleId;
    return startBundleId;
  }

  async getBlockByHeight(
    height: number,
  ): Promise<[BlockResponse, BlockResultsResponse]> {
    const bundleId = await this.getBundleId(height);
    const rawBundle = await this.getBundleById(bundleId.toString());
    const bundleData = await this.retrieveBundleData(rawBundle);

    const blockData = (
      await this.unzipStorageData(
        rawBundle.compression_id,
        bundleData.storageData,
      )
    ).find((bk: { value: any; key: string }) => bk.key === height.toString());

    return [
      this.decodeBlock(blockData.value.block),
      this.decodeBlockResult(blockData.value.block_results),
    ];
  }
}
