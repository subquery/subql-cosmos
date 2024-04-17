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
import { remove } from 'lodash';
import { BlockContent } from '../../indexer/types';
import { formatBlockUtil, LazyBlockContent } from '../cosmos';
import { isTmpDir } from '../project';
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
    if (!isTmpDir(tmpCacheDir)) {
      throw new Error('File cache directory must be a tmp directory');
    }

    const lcdClient = new KyveSDK(kyveChainId, {
      rpc: endpoint,
    }).createLCDClient();

    const poolId = await KyveApi.fetchPoolId(chainId, lcdClient);

    return new KyveApi(storageUrl, tmpCacheDir, poolId, lcdClient);
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
    let bundle = this.getBundleFromCache(height);
    if (!bundle) {
      const bundleId = await this.getBundleId(height);
      bundle = await this.getBundleById(bundleId);
      this.addToCachedBundle(bundle);
    }
    return JSON.parse(await this.getBundleData(bundle));
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
    });

    try {
      await new Promise((resolve, reject) => {
        writeStream.on('open', resolve);
        writeStream.on('error', reject);
      });

      const zippedBundleData = await this.retrieveBundleData(bundle.storage_id);

      const gunzip = zlib.createUnzip({
        maxOutputLength: MAX_COMPRESSION_BYTE_SIZE /* avoid zip bombs */,
      });

      await new Promise((resolve, reject) => {
        zippedBundleData.data
          .pipe(gunzip)
          .pipe(writeStream)
          .on('error', reject)
          .on('finish', resolve);
      });
    } catch (e) {
      if (!['EEXIST', 'EACCES', 'ENOENT'].includes(e.code)) {
        await fs.promises.unlink(bundleFilePath);
      }
      throw e;
    }

    await fs.promises.chmod(bundleFilePath, 0o444);
  }

  private async getBundleData(bundle: BundleDetails): Promise<string> {
    const bundleFilePath = this.getBundleFilePath(bundle.id);

    try {
      await this.downloadAndProcessBundle(bundle);
      return await this.readFromFile(bundleFilePath);
    } catch (e: any) {
      if (['EEXIST', 'EACCES', 'ENOENT'].includes(e.code)) {
        return this.pollUntilReadable(bundleFilePath);
      } else {
        throw e;
      }
    }
  }

  async readFromFile(bundleFilePath: string): Promise<string> {
    return fs.promises.readFile(bundleFilePath, 'utf-8');
  }

  private isBundleFile(filename: string): boolean {
    return /^bundle_\d+\.json$/.test(filename);
  }

  private async getExisitngBundlesFromCacheDirectory(
    tmpDir: string,
  ): Promise<BundleDetails[]> {
    const bundles: BundleDetails[] = [];
    const files = await fs.promises.readdir(tmpDir);

    for (const file of files) {
      if (this.isBundleFile(file)) {
        const id = parseDecimal(file.match(/^bundle_(\d+)\.json$/)[1]);
        bundles.push(await this.getBundleById(id));
      }
    }

    return bundles;
  }

  private async getToRemoveBundles(
    cachedBundles: BundleDetails[],
    height: number,
    bufferSize: number,
  ): Promise<BundleDetails[]> {
    if (!cachedBundles.length) {
      return this.getExisitngBundlesFromCacheDirectory(this.tmpCacheDir);
    }

    const currentBundle = this.getBundleFromCache(height);

    return cachedBundles.filter((b) => {
      const isNotCurrentBundleAndLower =
        currentBundle.id !== b.id &&
        parseDecimal(currentBundle.id) > parseDecimal(b.id);
      const isOutsiderBuffer =
        height < parseDecimal(b.from_key) - bufferSize ||
        height > parseDecimal(b.to_key) + bufferSize;

      return isNotCurrentBundleAndLower && isOutsiderBuffer;
    });
  }

  async clearFileCache(
    cachedBundles: BundleDetails[],
    height: number,
    bufferSize: number,
  ): Promise<void> {
    const toRemoveBundles = await this.getToRemoveBundles(
      cachedBundles,
      height,
      bufferSize,
    );

    for (const bundle of toRemoveBundles) {
      const bundlePath = this.getBundleFilePath(bundle.id);
      try {
        await fs.promises.unlink(bundlePath);
        remove(this.cachedBundleDetails, (b) => b.id === bundle.id);
      } catch (e) {
        if (e.code !== 'ENOENT') {
          // if it does not exist, should be removed
          throw e;
        }
      }
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
      throw new Error(`Failed to inject kyveBlock, ${e}`);
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
    bufferSize: number,
  ): Promise<IBlock<BlockContent>[]> {
    const blocks = await this.fetchBlocksArray(blockArray);
    const minHeight = Math.min(...blockArray);

    await this.clearFileCache(this.cachedBundleDetails, minHeight, bufferSize);

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
