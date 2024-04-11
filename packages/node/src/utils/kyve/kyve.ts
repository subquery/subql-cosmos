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
import { QueryPoolsResponse } from '@kyvejs/types/lcd/kyve/query/v1beta1/pools';
import { delay, getLogger } from '@subql/node-core';
import axios, { AxiosResponse } from 'axios';
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
  private currentBundleId = -1;
  private cachedBundleDetails: BundleDetails;

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

  static async fetchPoolId(
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
    return adaptor37.responses.decodeBlock({
      id: 1,
      jsonrpc: '2.0',
      result: block,
    });
  }

  private decodeBlockResult(
    blockResult: JsonRpcSuccessResponse,
  ): BlockResultsResponse {
    return adaptor37.responses.decodeBlockResults({
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
        /* if file does not exist, no need to clear fileCache */
      }

      return JSON.parse(await this.getFileCacheData());
    } else {
      return JSON.parse(
        await this.readFromFile(
          this.getBundleFilePath(this.cachedBundleDetails.id),
        ),
      );
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

  async downloadAndProcessBundle(bundleFilePath: string): Promise<void> {
    const writeStream = fs.createWriteStream(bundleFilePath, {
      flags: 'wx+',
    });

    const zippedBundleData = await this.retrieveBundleData();

    const gunzip = zlib.createUnzip({
      maxOutputLength: MAX_COMPRESSION_BYTE_SIZE /* avoid zip bombs */,
    });

    await new Promise((resolve, reject) => {
      zippedBundleData.data
        .on('error', (err) => reject(err))
        .pipe(gunzip)
        .on('error', (err) => reject(err))
        .pipe(writeStream)
        .on('error', (err) => reject(err))
        .on('finish', resolve);
    });

    await fs.promises.chmod(bundleFilePath, 0o444);
  }

  async getFileCacheData(): Promise<string> {
    const bundleFilePath = this.getBundleFilePath(this.cachedBundleDetails.id);

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

  async readFromFile(bundleFilePath: string): Promise<string> {
    return fs.promises.readFile(bundleFilePath, 'utf-8');
  }

  async clearFileCache(): Promise<void> {
    const currentBundleId = parseDecimal(this.cachedBundleDetails.id);
    const files = await fs.promises.readdir(this.tmpCacheDir);

    const minAllowedBundleId = currentBundleId - 2;

    const filesToRemove = files.filter((file) => {
      const match = file.match(/bundle_(\d+)/); // Extract bundle ID from filename
      return match && parseDecimal(match[1]) <= minAllowedBundleId;
    });

    for (const file of filesToRemove) {
      const filePath = path.join(this.tmpCacheDir, file);
      await fs.promises.unlink(filePath);
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
    return axios({
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
    });
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
