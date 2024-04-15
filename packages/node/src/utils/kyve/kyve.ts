// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import assert from 'assert';
import fs from 'fs';
import path from 'path';
import * as zlib from 'zlib';
import { JsonRpcSuccessResponse } from '@cosmjs/json-rpc';
import { Registry } from '@cosmjs/proto-signing';
import { logs } from '@cosmjs/stargate';
import { Responses } from '@cosmjs/tendermint-rpc/build/tendermint37/adaptor'; // adaptor is not exported
import {
  BlockResponse,
  BlockResultsResponse,
} from '@cosmjs/tendermint-rpc/build/tendermint37/responses';
import KyveSDK, { KyveLCDClientType } from '@kyvejs/sdk';
import { SupportedChains } from '@kyvejs/sdk/src/constants'; // Currently these types are not exported
import { QueryPoolsResponse } from '@kyvejs/types/lcd/kyve/query/v1beta1/pools';
import { delay, getLogger, IBlock } from '@subql/node-core';
import axios, { AxiosResponse } from 'axios';
import { BlockContent } from '../../indexer/types';
import { formatBlockUtil, LazyBlockContent } from '../cosmos';
import { BundleDetails } from './kyveTypes';

const BUNDLE_TIMEOUT = 10000; //ms
const POLL_TIMER = 3; // sec
const MAX_COMPRESSION_BYTE_SIZE = 2 * 10 ** 9;

const parseDecimal = (value: string) => parseInt(value, 10);

const logger = getLogger('kyve');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version: packageVersion } = require('../../../package.json');

interface KyveBundleData {
  value: { block: any; block_results: any };
  key: string;
}

export class KyveApi {
  private cachedBundleDetails: BundleDetails[] = [];

  private constructor(
    private readonly storageUrl: string,
    private readonly tmpCacheDir: string,
    private readonly poolId: string,
    private readonly lcdClient: KyveLCDClientType,
  ) {}

  static async create(
    chainId: string, // chainId for indexing chain
    endpoint: string,
    storageUrl: string,
    kyveChainId: SupportedChains,
    tmpCacheDir: string,
  ): Promise<KyveApi> {
    const lcdClient = new KyveSDK(kyveChainId, {
      rpc: endpoint,
    }).createLCDClient();

    const poolId = await KyveApi.fetchPoolId(chainId, lcdClient);

    const kyve = new KyveApi(storageUrl, tmpCacheDir, poolId, lcdClient);

    return kyve;
  }

  private static async fetchPoolId(
    chainId: string,
    lcdClient: KyveLCDClientType,
  ): Promise<string> {
    const poolsResponse =
      (await lcdClient.kyve.query.v1beta1.pools()) as unknown as QueryPoolsResponse;

    for (const p of poolsResponse.pools) {
      try {
        const config = JSON.parse(p.data.config);
        if (config.network === chainId) {
          return p.id; // Return the matching pool ID
        }
      } catch (error) {
        throw new Error(
          `Error parsing JSON for pool with id ${p.id}: ${error}`,
        );
      }
    }

    throw new Error(`${chainId} is not available on Kyve network`);
  }

  private decodeBlock(block: JsonRpcSuccessResponse): BlockResponse {
    return Responses.decodeBlock({
      id: 1,
      jsonrpc: '2.0',
      result: block,
    });
  }

  private decodeBlockResult(
    blockResult: JsonRpcSuccessResponse,
  ): BlockResultsResponse {
    return Responses.decodeBlockResults({
      id: 1,
      jsonrpc: '2.0',
      result: blockResult,
    });
  }

  private getBundleFilePath(id: string): string {
    return path.join(this.tmpCacheDir, `bundle_${id}.json`);
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

    let low =
      this.cachedBundleDetails.length > 0
        ? Math.min(...this.cachedBundleDetails.map((b) => parseDecimal(b.id)))
        : -1;
    let high = latestBundleId;
    let startBundleId = -1; // Initialize to an invalid ID initially

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const midBundle = await this.getBundleById(mid);

      const fromKey = parseDecimal(midBundle.from_key);
      const toKey = parseDecimal(midBundle.to_key);

      if (height >= fromKey && height <= toKey) {
        startBundleId = mid;
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
    fileCacheData: KyveBundleData[],
  ): KyveBundleData | undefined {
    return fileCacheData.find(
      (bk: KyveBundleData) => bk.key === height.toString(),
    );
  }

  private addToCachedBundle(bundle: BundleDetails): void {
    if (!this.cachedBundleDetails.find((b) => b.id === bundle.id)) {
      this.cachedBundleDetails.push(bundle);
    }
  }

  private getBundleFromCache(height: number): BundleDetails | undefined {
    return this.cachedBundleDetails.find(
      (b) =>
        parseDecimal(b.from_key) <= height && height <= parseDecimal(b.to_key),
    );
  }

  private async updateCurrentBundleAndDetails(
    height: number,
  ): Promise<KyveBundleData[]> {
    if (this.cachedBundleDetails.length === 0) {
      const bundleId = await this.getBundleId(height);
      const bundleDetail = await this.getBundleById(bundleId);
      this.addToCachedBundle(bundleDetail);
    }

    const bundle = this.getBundleFromCache(height);
    if (bundle) {
      return JSON.parse(await this.getFileCacheData(bundle));
    } else {
      const bundleId = await this.getBundleId(height);
      const newBundleDetails = await this.getBundleById(bundleId);

      this.addToCachedBundle(newBundleDetails);
      return JSON.parse(await this.getFileCacheData(newBundleDetails));
    }
  }

  private async pollUntilReadable(bundleFilePath: string): Promise<string> {
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

  async downloadAndProcessBundle(bundle: BundleDetails): Promise<void> {
    const bundleFilePath = this.getBundleFilePath(bundle.id);

    const writeStream = fs.createWriteStream(bundleFilePath, {
      flags: 'wx',
      mode: 0o200, // write only access for owner
    });

    // to ensure the stream to throw an on-stack error
    await new Promise((resolve, reject) => {
      writeStream.on('open', resolve);
      writeStream.on('error', (err) => {
        reject(err);
      });
    }).catch((e) => {
      throw e;
    });

    const zippedBundleData = await this.retrieveBundleData(bundle.storage_id);

    const gunzip = zlib.createUnzip({
      maxOutputLength: MAX_COMPRESSION_BYTE_SIZE /* avoid zip bombs */,
    });

    await new Promise((resolve, reject) => {
      zippedBundleData.data
        .pipe(gunzip)
        .on('error', reject)
        .pipe(writeStream)
        .on('finish', resolve);
    });

    await fs.promises.chmod(bundleFilePath, 0o444);
  }

  private async getFileCacheData(bundle: BundleDetails): Promise<string> {
    const bundleFilePath = this.getBundleFilePath(bundle.id);

    try {
      await this.downloadAndProcessBundle(bundle);
      return await this.readFromFile(bundleFilePath);
    } catch (e: any) {
      if (['EEXIST', 'EACCES', 'ENOENT'].includes(e.code)) {
        return this.pollUntilReadable(bundleFilePath);
      } else {
        await fs.promises.unlink(bundleFilePath);
        throw e;
      }
    }
  }

  async readFromFile(bundleFilePath: string): Promise<string> {
    return fs.promises.readFile(bundleFilePath, 'utf-8');
  }

  // todo unsure when to clear the file cache
  private async clearFileCache(height: number): Promise<void> {
    const bundleToRemove = this.cachedBundleDetails.filter(
      (b) => parseDecimal(b.from_key) > height,
    );

    for (const bundle of bundleToRemove) {
      const bundlePath = this.getBundleFilePath(bundle.id);
      await fs.promises.unlink(bundlePath);
    }
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

  private injectLogs(
    kyveBlockResult: BlockResultsResponse,
  ): BlockResultsResponse {
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

  private reconstructLogs(
    blockResultResponse: BlockResultsResponse,
  ): logs.Log[] {
    const logs: logs.Log[] = [];

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
    // use for loop instead ?
    // mem a promise

    // for loop resolve and get bundle for block, save a promise for bundle id

    // await promise in cache
    // once bundle has been resolved
    return Promise.all(
      blockArray.map(async (height) => this.getBlockByHeight(height)),
    );
  }

  private async retrieveBundleData(storageId: string): Promise<AxiosResponse> {
    return axios({
      method: 'get',
      url: storageId,
      baseURL: this.storageUrl,
      responseType: 'stream',
      timeout: BUNDLE_TIMEOUT,
      headers: {
        'User-Agent': `SubQuery-Node ${packageVersion}`,
        Connection: 'keep-alive',
        'Content-Encoding': 'gzip',
      },
    });
  }

  async fetchBlocksBatches(
    registry: Registry,
    blockArray: number[],
  ): Promise<IBlock<BlockContent>[]> {
    const blocks = await this.fetchBlocksArray(blockArray);
    return blocks.map(([blockInfo, blockResults]) => {
      try {
        assert(
          blockResults.results.length === blockInfo.block.txs.length,
          `txInfos doesn't match up with block (${blockInfo.block.header.height}) transactions expected ${blockInfo.block.txs.length}, received: ${blockResults.results.length}`,
        );

        return formatBlockUtil(
          new LazyBlockContent(blockInfo, blockResults, registry),
        );
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
