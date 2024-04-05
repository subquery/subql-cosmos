// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import assert from 'assert';
import { JsonRpcSuccessResponse } from '@cosmjs/json-rpc';
import { Registry } from '@cosmjs/proto-signing';
import { Log } from '@cosmjs/stargate/build/logs';
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
import {
  PoolResponse,
  QueryPoolsResponse,
} from '@kyvejs/types/lcd/kyve/query/v1beta1/pools';
import { getLogger } from '@subql/node-core';
import axios, { AxiosRequestConfig } from 'axios';
import { BlockContent } from '../../indexer/types';
import { LazyBlockContent } from '../cosmos';
import { BundleDetails } from './kyveTypes';

const BUNDLE_TIMEOUT = 10000; //ms

const parseDecimal = (value: string) => parseInt(value, 10);

const logger = getLogger('kyve');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version: packageVersion } = require('../../../package.json');

interface UnZippedKyveBlockReponse {
  value: { block: any; block_results: any };
  key: string;
}

export class KyveApi {
  private lcdClient: KyveLCDClientType;
  private respAdaptor = adaptor37.responses;
  private poolId: string;
  private currentBundleId = -1;
  private cachedBlocks: UnZippedKyveBlockReponse[];
  private cachedBundle: StorageReceipt; // storage Data

  private constructor(
    private chainId: string,
    private endpoint: string,
    private readonly storageUrl: string,
    private readonly kyveChainId: SupportedChains,
  ) {
    this.lcdClient = new KyveSDK(kyveChainId, {
      rpc: this.endpoint,
    }).createLCDClient();
    this.storageUrl = storageUrl;
  }

  static async create(
    chainId: string, // chainId for indexing chain
    endpoint: string,
    storageUrl: string,
    kyveChainId: SupportedChains,
  ): Promise<KyveApi> {
    const kyve = new KyveApi(chainId, endpoint, storageUrl, kyveChainId);
    await kyve.setPoolId();

    return kyve;
  }

  get getLcdClient(): KyveLCDClientType {
    return this.lcdClient;
  }

  private async getAllPools(): Promise<QueryPoolsResponse> {
    return (await this.lcdClient.kyve.query.v1beta1.pools()) as unknown as QueryPoolsResponse;
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
    storageData: Buffer,
  ): Promise<UnZippedKyveBlockReponse[]> {
    const g = new Gzip();
    if (parseDecimal(compressionId) === 0) {
      return storageData as any;
    }

    const buffer = await g.decompress(storageData);
    const parsedString = buffer.toString('utf-8');

    try {
      return JSON.parse(parsedString);
    } catch (e) {
      throw new Error(`Failed to parse storageData. ${e}`);
    }
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
      parseDecimal(
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

      const fromKey = parseDecimal(midBundle.from_key);
      const toKey = parseDecimal(midBundle.to_key);

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
    if (!this.cachedBundle || parseDecimal(bundleDetails.to_key) > height) {
      this.currentBundleId++;

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
    const bundleId =
      this.currentBundleId === -1
        ? await this.getBundleId(height)
        : this.currentBundleId;

    const bundleDetails = await this.getBundleById(bundleId);
    await this.validateCache(height, bundleDetails);

    const blockData = this.findBlockByHeight(height);

    return [
      this.decodeBlock(blockData.value.block),
      this.injectLogs(this.decodeBlockResult(blockData.value.block_results)),
    ];
  }

  private injectLogs(kyveBlockResult: BlockResultsResponse) {
    try {
      kyveBlockResult.results.forEach((b) => {
        // log is readonly hence needing to cast it
        (b.log as any) = JSON.stringify(this.reconstructLogs(kyveBlockResult));
      });
    } catch (e) {
      throw new Error(`Failed to inject kyveBlock`);
    }
    return kyveBlockResult;
  }

  private reconstructLogs(blockResultResponse: BlockResultsResponse): Log[] {
    const logs: Log[] = [];

    for (const tx of blockResultResponse.results) {
      let currentLog: any = {
        msg_index: -1,
        events: [],
      };

      let msgIndex = -1;
      for (const event of tx.events) {
        const isMessageEvent =
          event.type === 'message' &&
          event.attributes.some((e) => e.key === 'action');

        if (isMessageEvent) {
          if (msgIndex >= 0) {
            logs.push(currentLog);
          }
          msgIndex += 1;
          currentLog = { msg_index: msgIndex, events: [] };
        }

        if (msgIndex >= 0) {
          currentLog.events.push(event);
        }
      }

      if (currentLog.events.length > 0) {
        logs.push(currentLog);
      }
    }
    return logs;
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
      url: `${storageId}`,
      baseURL: this.storageUrl,
      responseType: 'arraybuffer',
      timeout,
      headers: {
        'User-Agent': `SubQuery-Node ${packageVersion}`,
        Connection: 'keep-alive',
        'Content-Encoding': 'gzip',
      },
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

        return new LazyBlockContent(blockInfo, blockResults, registry);
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
