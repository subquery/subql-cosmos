// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import assert from 'assert';
import fs from 'fs';
import { isMainThread } from 'node:worker_threads';
import os from 'os';
import path from 'path';
import * as zlib from 'zlib';
import { JsonRpcSuccessResponse } from '@cosmjs/json-rpc';
import { Registry } from '@cosmjs/proto-signing';
import { logs } from '@cosmjs/stargate';
import {
  BlockResponse,
  BlockResultsResponse,
  TxData,
} from '@cosmjs/tendermint-rpc/build/tendermint37';
import { Responses } from '@cosmjs/tendermint-rpc/build/tendermint37/adaptor'; // adaptor is not exported
import KyveSDK, { KyveLCDClientType } from '@kyvejs/sdk';
import { SupportedChains } from '@kyvejs/sdk/src/constants'; // Currently these types are not exported
import { QueryPoolsResponse } from '@kyvejs/types/lcd/kyve/query/v1beta1/pools';
import { LocalReader } from '@subql/common';
import { delay, getLogger, IBlock, timeout } from '@subql/node-core';
import { Reader } from '@subql/types-core';
import axios, { AxiosResponse } from 'axios';
import { BlockContent } from '../../indexer/types';
import { formatBlockUtil, LazyBlockContent } from '../cosmos';
import { isTmpDir } from '../project';
import { BundleDetails } from './kyveTypes';

const BUNDLE_TIMEOUT = 10000; //ms
const POLL_TIMER = 3; // sec
const POLL_LIMIT = 10;
const MAX_COMPRESSION_BYTE_SIZE = 2 * 10 ** 9;
const BUNDLE_FILE_ID_REG = (poolId: string) =>
  new RegExp(`^bundle_${poolId}_(\\d+)\\.json$`);

const parseDecimal = (value: string) => parseInt(value, 10);

const logger = getLogger('kyve');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version: packageVersion } = require('../../../package.json');

interface KyveBundleData {
  value: { block: any; block_results: any };
  key: string;
}

export class KyveApi {
  private cachedBundleDetails: Record<number, Promise<BundleDetails>> = {};

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

    await KyveApi.clearStaleFiles(tmpCacheDir, poolId);

    logger.info(`Kyve API connected`);
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

  private static async clearStaleFiles(
    fileCacheDir: string,
    poolId: string,
  ): Promise<void> {
    if (isMainThread) {
      const files = await fs.promises.readdir(fileCacheDir);

      const isStaleBundle = async (file: string) => {
        try {
          const isStale =
            ((await fs.promises.stat(file)).mode & 0o777).toString(8) === '200';
          if (isStale) {
            logger.debug(`Removing stale bundle: ${file}`);
            await fs.promises.unlink(file);
          }
        } catch (e) {
          if (e.code !== 'ENOENT') {
            logger.error(`Failed to clear bundle: ${file}`);
            throw e;
          }
        }
      };
      await Promise.all(
        files
          .filter((f) => KyveApi.isBundleFile(f, poolId))
          .map((bundleFile) => isStaleBundle(bundleFile)),
      );
    }
  }

  private static isBundleFile(filename: string, poolId: string): boolean {
    return BUNDLE_FILE_ID_REG(poolId).test(filename);
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
    return path.join(this.tmpCacheDir, `bundle_${this.poolId}_${id}.json`);
  }

  private async getBundleById(bundleId: number): Promise<BundleDetails> {
    return (this.cachedBundleDetails[bundleId] ??= (() => {
      logger.debug(`getBundleId ${bundleId}`);
      return this.lcdClient.kyve.query.v1beta1.finalizedBundle({
        pool_id: this.poolId,
        id: bundleId.toString(),
      }) as Promise<BundleDetails>;
    })());
  }

  private async getResolvedBundleDetails(): Promise<BundleDetails[]> {
    return Promise.all(Object.values(this.cachedBundleDetails));
  }

  private async getLatestBundleId(): Promise<number> {
    return parseDecimal(
      (
        await this.lcdClient.kyve.query.v1beta1.finalizedBundles({
          pool_id: this.poolId,
          index: '1',
          pagination: {
            reverse: true,
            limit: '1',
          },
        })
      ).finalized_bundles[0].id,
    );
  }

  /**
   * Find bundleID based on height
   * @description Increment bundleId by 1 until height is found in bundle
   */
  private async getBundleIdIncrement(height: number): Promise<number> {
    let bundle: BundleDetails;
    let bundleId: number;

    const cachedBundles = await this.getResolvedBundleDetails();
    const nearestBundle = cachedBundles.filter(
      (b) => parseDecimal(b.to_key) < height,
    );

    bundleId = Math.max(...nearestBundle.map((b) => parseDecimal(b.id))) + 1;

    bundle = await this.getBundleById(bundleId);

    while (parseDecimal(bundle.to_key) < height) {
      bundleId++;
      bundle = await this.getBundleById(bundleId);
    }
    return parseDecimal(bundle.id);
  }

  /**
   * Find bundleID based on height
   * @description Binary search to find height in bundle
   */
  private async getBundleIdSearch(height: number): Promise<number> {
    const lowestCacheHeight = Object.keys(this.cachedBundleDetails);

    let low =
      lowestCacheHeight.length > 0
        ? Math.min(...lowestCacheHeight.map(parseDecimal))
        : -1;
    let high = await this.getLatestBundleId();

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const midBundle = await this.getBundleById(mid);

      const fromKey = parseDecimal(midBundle.from_key);
      const toKey = parseDecimal(midBundle.to_key);

      if (height >= fromKey && height <= toKey) {
        return mid;
      }

      if (height > toKey) {
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    throw new Error(`No suitable bundle found for height ${height}`);
  }

  private findBlockByHeight(
    height: number,
    fileCacheData: KyveBundleData[],
  ): KyveBundleData | undefined {
    return fileCacheData.find(
      (bk: KyveBundleData) => bk.key === height.toString(),
    );
  }

  private async getBundleFromCache(
    height: number,
  ): Promise<BundleDetails> | undefined {
    const bundles = await this.getResolvedBundleDetails();
    return bundles.find(
      (b) =>
        parseDecimal(b.from_key) <= height && height <= parseDecimal(b.to_key),
    );
  }

  private async updateCurrentBundleAndDetails(
    height: number,
  ): Promise<KyveBundleData[]> {
    let bundle = await this.getBundleFromCache(height);

    if (!bundle) {
      const bundleIds = Object.keys(this.cachedBundleDetails);

      const bundleId =
        bundleIds.length === 0
          ? await this.getBundleIdSearch(height)
          : await this.getBundleIdIncrement(height);

      bundle = await this.cachedBundleDetails[bundleId];
    }

    return JSON.parse(await this.getBundleData(bundle));
  }

  private async pollUntilReadable(bundleFilePath: string): Promise<string> {
    let limit = POLL_LIMIT;
    while (limit > 0) {
      try {
        return await this.readFromFile(bundleFilePath);
      } catch (e) {
        if (e.code === 'EACCES') {
          await delay(POLL_TIMER);
          limit--;
        } else {
          throw e;
        }
      }
    }
    throw new Error('Timeout waiting for bundle');
  }

  async downloadAndProcessBundle(bundle: BundleDetails): Promise<void> {
    const bundleFilePath = this.getBundleFilePath(bundle.id);

    const writeStream = fs.createWriteStream(bundleFilePath, {
      flags: 'wx',
      mode: 0o200, // Ensure that only writer has access to file
    });

    try {
      await timeout(
        new Promise((resolve, reject) => {
          writeStream.on('open', resolve);
          writeStream.on('error', reject);
        }),
        BUNDLE_TIMEOUT,
      );

      const zippedBundleData = await this.retrieveBundleData(bundle.storage_id);

      const gunzip = zlib.createUnzip({
        maxOutputLength: MAX_COMPRESSION_BYTE_SIZE /* avoid zip bombs */,
      });

      logger.debug(`Retrieving bundle ${bundle.id}`);
      logger.info(`Fetching blocks ${bundle.from_key} to ${bundle.to_key}`);

      await new Promise((resolve, reject) => {
        zippedBundleData.data
          .pipe(gunzip)
          .pipe(writeStream)
          .on('error', reject)
          .on('finish', resolve);
      });

      await fs.promises.chmod(bundleFilePath, 0o444);

      logger.debug(`Bundle ${bundle.id} ready`);
    } catch (e) {
      if (!['EEXIST', 'EACCES'].includes(e.code)) {
        await this.unlinkFile(bundleFilePath);
      }
      throw e;
    }
  }

  private async unlinkFile(file: string): Promise<void> {
    await fs.promises.unlink(file).catch((e) => {
      // If file does not exist, no need to remove
      if (e.code !== 'ENOENT') throw e;
    });
  }

  private async getBundleData(bundle: BundleDetails): Promise<string> {
    const bundleFilePath = this.getBundleFilePath(bundle.id);
    try {
      await this.downloadAndProcessBundle(bundle);
      return await this.readFromFile(bundleFilePath);
    } catch (e: any) {
      if (['EEXIST', 'EACCES'].includes(e.code)) {
        const res = await this.pollUntilReadable(bundleFilePath);
        return res;
      }
      await this.unlinkFile(bundleFilePath);
      throw e;
    }
  }

  async readFromFile(bundleFilePath: string): Promise<string> {
    return fs.promises.readFile(bundleFilePath, 'utf-8');
  }

  private async getExistingBundlesFromCacheDirectory(
    tmpDir: string,
  ): Promise<BundleDetails[]> {
    const files = await fs.promises.readdir(tmpDir);

    return Promise.all(
      files
        .filter((file) => KyveApi.isBundleFile(file, this.poolId))
        .map((file) => {
          const id = parseDecimal(
            file.match(BUNDLE_FILE_ID_REG(this.poolId))[1],
          );
          return this.getBundleById(id);
        }),
    );
  }

  private async getToRemoveBundles(
    cachedBundles: Record<string, Promise<BundleDetails>>,
    height: number,
    bufferSize: number,
  ): Promise<BundleDetails[]> {
    if (!Object.keys(cachedBundles).length) {
      return this.getExistingBundlesFromCacheDirectory(this.tmpCacheDir);
    }

    const currentBundle = await this.getBundleFromCache(height);
    const bundles = await Promise.all(Object.values(cachedBundles));

    return bundles.filter((b) => {
      const isNotCurrentBundleAndLower =
        currentBundle.id !== b.id &&
        parseDecimal(currentBundle.id) > parseDecimal(b.id);
      const isOutsiderBuffer = height > parseDecimal(b.to_key) + bufferSize;

      return isNotCurrentBundleAndLower && isOutsiderBuffer;
    });
  }

  async clearFileCache(
    cachedBundles: Record<string, Promise<BundleDetails>>,
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
        await this.unlinkFile(bundlePath);
        logger.debug(`Removed bundle ${bundle.id}`);
      } finally {
        delete this.cachedBundleDetails[bundle.id];
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
        (b.log as string) = JSON.stringify(this.reconstructLog(b));
      });
    } catch (e) {
      throw new Error(`Failed to inject kyveBlock, ${e}`);
    }
    return kyveBlockResult;
  }

  private reconstructLog(txData: TxData): logs.Log[] {
    const logs: logs.Log[] = [];

    let currentLog: any = {
      msg_index: -1,
      events: [],
    };

    let msgIndex = -1;
    for (const event of txData.events) {
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

  static async getFileCacheDir(
    reader: Reader,
    projectRoot: string,
    chainId: string,
  ): Promise<string> {
    if (isTmpDir(projectRoot)) return projectRoot;
    if (reader instanceof LocalReader) {
      const tmpDir = path.join(os.tmpdir(), `kyveTmpFileCache_${chainId}`);
      try {
        await fs.promises.mkdir(tmpDir);
        return tmpDir;
      } catch (e) {
        if (e.code === 'EEXIST') {
          return tmpDir;
        }
        throw e;
      }
    }
    return projectRoot;
  }
}
