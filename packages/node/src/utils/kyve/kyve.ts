// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import * as zlib from 'zlib';
import { JsonRpcSuccessResponse } from '@cosmjs/json-rpc';
import { Registry } from '@cosmjs/proto-signing';
import { Log } from '@cosmjs/stargate/build/logs';
import { adaptor37 } from '@cosmjs/tendermint-rpc/build/tendermint37/adaptor';
import {
  BlockResponse,
  BlockResultsResponse,
} from '@cosmjs/tendermint-rpc/build/tendermint37/responses';
import KyveSDK, { KyveLCDClientType } from '@kyvejs/sdk';
import { SupportedChains } from '@kyvejs/sdk/src/constants'; // Currently these types are not exported
import {
  PoolResponse,
  QueryPoolsResponse,
} from '@kyvejs/types/lcd/kyve/query/v1beta1/pools';
import { delay, getLogger } from '@subql/node-core';
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import { BlockContent } from '../../indexer/types';
import { LazyBlockContent } from '../cosmos';
import { BundleDetails } from './kyveTypes';

const BUNDLE_TIMEOUT = 10000; //ms
const POLL_TIMER = 3; // sec
const MAX_COMPRESSION_BYTE_SIZE = 2 * 10 ** 9;

const parseDecimal = (value: string) => parseInt(value, 10);

const logger = getLogger('kyve');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version: packageVersion } = require('../../../package.json');

interface UnZippedKyveBlockReponse {
  value: { block: any; block_results: any };
  key: string;
}

export class KyveApi {
  private readonly lcdClient: KyveLCDClientType;
  private respAdaptor = adaptor37.responses;
  private poolId: string;
  private currentBundleId = -1;
  private cachedBundleDetails: BundleDetails;

  private constructor(
    private chainId: string,
    private endpoint: string,
    private readonly storageUrl: string,
    private readonly kyveChainId: SupportedChains,
    private readonly tmpCacheDir: string,
  ) {
    this.lcdClient = new KyveSDK(this.kyveChainId, {
      rpc: this.endpoint,
    }).createLCDClient();
    this.storageUrl = storageUrl;
  }

  static async create(
    chainId: string, // chainId for indexing chain
    endpoint: string,
    storageUrl: string,
    kyveChainId: SupportedChains,
    tmpCacheDir: string,
  ): Promise<KyveApi> {
    const kyve = new KyveApi(
      chainId,
      endpoint,
      storageUrl,
      kyveChainId,
      tmpCacheDir,
    );
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

  private findBlockByHeight(
    height: number,
    fileCacheData: UnZippedKyveBlockReponse[],
  ): UnZippedKyveBlockReponse {
    return fileCacheData.find(
      (bk: UnZippedKyveBlockReponse) => bk.key === height.toString(),
    );
  }

  async updateCurrentBundleAndDetails(
    height: number,
  ): Promise<UnZippedKyveBlockReponse[]> {
    // this is on init, and then when height is greater than current cache
    if (
      this.currentBundleId === -1 ||
      parseDecimal(this.cachedBundleDetails.to_key) < height
    ) {
      this.currentBundleId =
        this.currentBundleId === -1
          ? await this.getBundleId(height)
          : this.currentBundleId + 1;
      this.cachedBundleDetails = await this.getBundleById(this.currentBundleId);
      try {
        await fs.promises.access(
          path.join(
            this.tmpCacheDir,
            `bundle_${parseDecimal(this.cachedBundleDetails.id) - 2}`,
          ),
        );
        await this.clearFileCache();
      } catch (e) {
        /* empty */
      }

      return this.jsonParseWrapper(await this.getFileCacheData());
    }
  }

  async pollUntilReadable(bundleFilePath: string): Promise<string> {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        return await this.readFromFile(bundleFilePath);
      } catch (e) {
        if (e.code === 'EACCES') {
          await delay(POLL_TIMER);
        } else {
          throw e;
        }
      }
    }
  }

  async downloadAndProcessBundle(bundleFilePath: string): Promise<void> {
    const writeStream = fs.createWriteStream(bundleFilePath, {
      flags: 'wx+',
    });

    const zippedBundleData = await this.retrieveBundleData();

    const gunzip = zlib.createUnzip({
      maxOutputLength: MAX_COMPRESSION_BYTE_SIZE /* avoid zip bombs */,
    });
    zippedBundleData.data
      .pipe(gunzip)
      .pipe(writeStream)
      .on('error', (err) => {
        // TODO i am unsure if this is working with async
        if (err.code === 'EEXIST') {
          return this.pollUntilReadable(bundleFilePath);
        } else {
          throw err;
        }
      })
      .on('finish', () => {
        return fs.promises.chmod(bundleFilePath, 0o444);
      });
  }

  async getFileCacheData(): Promise<string> {
    const bundleFilePath = path.join(
      this.tmpCacheDir,
      `bundle_${this.cachedBundleDetails.id}`,
    );

    try {
      await this.downloadAndProcessBundle(bundleFilePath);
      return await this.readFromFile(bundleFilePath);
    } catch (e: any) {
      if (['EEXIST', 'EACCES', 'ENOENT'].includes(e.code)) {
        return this.pollUntilReadable(bundleFilePath);
      } else {
        throw e;
      }
    }
  }

  private jsonParseWrapper(data: string) {
    try {
      return JSON.parse(data);
    } catch (e) {
      throw new Error(`Failed to parse storageData. ${e}`);
    }
  }

  async readFromFile(bundleFilePath: string): Promise<string> {
    return fs.promises.readFile(bundleFilePath, 'utf-8');
  }

  async clearFileCache(): Promise<void> {
    await fs.promises.unlink(
      path.join(
        this.tmpCacheDir,
        `bundle_${parseDecimal(this.cachedBundleDetails.id) - 2}`,
      ),
    );
  }

  async getBlockByHeight(
    height: number,
  ): Promise<[BlockResponse, BlockResultsResponse]> {
    const blocks = await this.updateCurrentBundleAndDetails(height);

    const blockData = this.findBlockByHeight(height, blocks);

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

  private async retrieveBundleData(): Promise<AxiosResponse> {
    const axiosConfig: AxiosRequestConfig = {
      method: 'get',
      url: this.cachedBundleDetails.storage_id,
      baseURL: this.storageUrl,
      responseType: 'stream',
      timeout: BUNDLE_TIMEOUT,
      headers: {
        'User-Agent': `SubQuery-Node ${packageVersion}`,
        Connection: 'keep-alive',
        'Content-Encoding': 'gzip',
      },
    };
    return axios(axiosConfig);
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
