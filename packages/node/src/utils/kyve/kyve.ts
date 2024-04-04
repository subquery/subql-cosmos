// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import assert from 'assert';
import { JsonRpcSuccessResponse } from '@cosmjs/json-rpc';
import { Registry } from '@cosmjs/proto-signing';
import { adaptor37 } from '@cosmjs/tendermint-rpc/build/tendermint37/adaptor';
import {
  BlockResponse,
  BlockResultsResponse,
} from '@cosmjs/tendermint-rpc/build/tendermint37/responses';
// Currently these types are not exported
import { StorageReceipt } from '@kyvejs/protocol';
import { Gzip } from '@kyvejs/protocol/dist/src/reactors/compression/Gzip';
import KyveSDK, { KyveLCDClientType } from '@kyvejs/sdk';
import { SupportedChains } from '@kyvejs/sdk/src/constants';
import { PoolResponse } from '@kyvejs/types/lcd/kyve/query/v1beta1/pools';
import { getLogger } from '@subql/node-core';
import {
  CosmosBlock,
  CosmosEvent,
  CosmosTransaction,
} from '@subql/types-cosmos';
import axios, { AxiosRequestConfig } from 'axios';
import { BlockContent } from '../../indexer/types';
import { LazyBlockContent, wrapCosmosMsg } from '../cosmos';
import { BundleDetails } from './kyveTypes';

const BUNDLE_TIMEOUT = 10000; //ms
const RADIX = 10;

const parseIntRadix = (value: string) => parseInt(value, RADIX);

const logger = getLogger('kyve');

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
  private cachedBundle: any; // storage Data
  private storageUrl: string;

  constructor(
    private chainId: string,
    storageUrl: string,
    kyveChainId: SupportedChains = 'kyve-1',
  ) {
    this.storageUrl = storageUrl;
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

    let pool: PoolResponse;
    for (const p of pools.pools) {
      try {
        const config = JSON.parse(p.data.config);
        if (config.network === this.chainId) {
          pool = p as unknown as PoolResponse;
          break;
        }
      } catch (error) {
        throw new Error(
          `Error parsing JSON for pool with id ${p.id}:, ${error}`,
        );
      }
    }

    if (!pool) {
      throw new Error(`${this.chainId} is not available on Kyve network`);
    }

    this.poolId = pool.id;
  }

  private async unzipStorageData(
    compressionId: string,
    storageData: any,
  ): Promise<UnZippedKyveBlockReponse[]> {
    const g = new Gzip();
    if (parseIntRadix(compressionId) === 0) {
      throw new Error('No Compression');
    }

    const buffer = await g.decompress(storageData);
    const parsedString = buffer.toString('utf-8');

    return JSON.parse(parsedString);
  }

  private decodeBlock(block: JsonRpcSuccessResponse): BlockResponse {
    return this.respAdaptor.decodeBlock({
      id: 1,
      jsonrpc: '2.0',
      result: block,
    });
  }

  private decodeBlockResult(
    blockResult: JsonRpcSuccessResponse,
  ): BlockResultsResponse {
    return this.respAdaptor.decodeBlockResults({
      id: 1,
      jsonrpc: '2.0',
      result: blockResult,
    });
  }

  private async getBundleById(bundleId: number): Promise<BundleDetails> {
    const bundleDetail =
      await this.lcdClient.kyve.query.v1beta1.finalizedBundle({
        pool_id: this.poolId,
        id: bundleId.toString(),
      });
    return bundleDetail as BundleDetails;
  }

  private async getLatestBundleId(): Promise<number> {
    return (
      parseIntRadix(
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

      const fromKey = parseIntRadix(midBundle.from_key);
      const toKey = parseIntRadix(midBundle.to_key);

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
    throw new Error(`No suitable bundle found for height ${height}}`);
  }

  private findBlockByHeight(height: number): UnZippedKyveBlockReponse {
    return this.cachedBlocks.find(
      (bk: UnZippedKyveBlockReponse) => bk.key === height.toString(),
    );
  }

  private async validateCache(height: number, bundleDetails: BundleDetails) {
    if (!this.cachedBundle || parseIntRadix(bundleDetails.to_key) > height) {
      this.cachedBundle = await this.retrieveBundleData(
        bundleDetails.storage_id,
        BUNDLE_TIMEOUT,
      );

      this.cachedBlocks = await this.unzipStorageData(
        bundleDetails.compression_id,
        this.cachedBundle.storageData,
      );
    }
  }

  async getBlockByHeight(
    height: number,
  ): Promise<[BlockResponse, BlockResultsResponse]> {
    const bundleId = await this.getBundleId(height);
    const bundleDetails = await this.getBundleById(bundleId);

    await this.validateCache(height, bundleDetails);

    const blockData = this.findBlockByHeight(height);

    return [
      this.decodeBlock(blockData.value.block),
      this.decodeBlockResult(blockData.value.block_results),
    ];
  }

  wrapEvent(
    block: CosmosBlock,
    txs: CosmosTransaction[],
    registry: Registry,
    idxOffset: number, //use this offset to avoid clash with idx of begin block events
  ): CosmosEvent[] {
    const events: CosmosEvent[] = [];
    for (const tx of txs) {
      let msgIndex = -1;
      for (const event of tx.tx.events) {
        if (
          event.type === 'message' &&
          event.attributes.find((e) => e.key === 'action')
        ) {
          msgIndex += 1;
        }

        if (msgIndex >= 0) {
          const msg = wrapCosmosMsg(block, tx, msgIndex, registry);
          const cosmosEvent: CosmosEvent = {
            idx: idxOffset++,
            msg,
            tx,
            block,
            log: undefined,
            event,
          };
          events.push(cosmosEvent);
        }
      }
    }
    return events;
  }

  private async fetchBlocksArray(
    blockArray: number[],
  ): Promise<[BlockResponse, BlockResultsResponse][]> {
    return Promise.all(
      blockArray.map(async (height) => this.getBlockByHeight(height)),
    );
  }

  private async retrieveBundleData(
    storageId: string,
    timeout: number,
  ): Promise<StorageReceipt> {
    const axiosConfig: AxiosRequestConfig = {
      method: 'get',
      url: `/${storageId}`,
      baseURL: this.storageUrl,
      responseType: 'arraybuffer',
      timeout,
    };
    const { data: storageData } = await axios(axiosConfig);

    return { storageId, storageData };
  }

  async fetchBlocksBatches(
    registry: Registry,
    blockArray: number[],
  ): Promise<BlockContent[]> {
    const blocks = await this.fetchBlocksArray(blockArray);
    return blocks.map(([blockInfo, blockResults]) => {
      try {
        assert(
          blockResults.results.length === blockInfo.block.txs.length,
          `txInfos doesn't match up with block (${blockInfo.block.header.height}) transactions expected ${blockInfo.block.txs.length}, received: ${blockResults.results.length}`,
        );

        return new LazyBlockContent(blockInfo, blockResults, registry, this);
      } catch (e) {
        logger.error(
          e,
          `Failed to fetch and prepare block ${blockInfo.block.header.height}`,
        );
        throw e;
      }
    });
  }
}
