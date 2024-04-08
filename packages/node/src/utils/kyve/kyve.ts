// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import assert from 'assert';
import fs from 'fs';
import path from 'path';
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
const POLL_TIMER = 1000; // ms

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

  private async unzipStorageData(
    compressionId: string,
    storageData: Buffer,
  ): Promise<Buffer> {
    const g = new Gzip();
    if (parseDecimal(compressionId) === 0) {
      return storageData as any;
    }

    return g.decompress(storageData);
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

  private async findBlockByHeight(
    height: number,
  ): Promise<UnZippedKyveBlockReponse> {
    const bundleFilePath = path.join(
      this.tmpCacheDir,
      `bundle_${this.cachedBundleDetails.id}`,
    );

    return (await this.readFromFile(bundleFilePath)).find(
      (bk: UnZippedKyveBlockReponse) => bk.key === height.toString(),
    );
  }

  async updateCurrentBundleAndDetails(height: number): Promise<void> {
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

      if (parseDecimal(this.cachedBundleDetails.to_key) < height) {
        await this.clearFileCache();
      }

      const lockFilePath = path.join(
        this.tmpCacheDir,
        `bundle_${this.cachedBundleDetails.id}.lock`,
      );
      try {
        await this.downloadAndWriteToFile(lockFilePath);
      } catch (e: any) {
        if (e?.code !== 'EACCES') {
          throw e;
        }

        await this.pollUntilUnlocked(lockFilePath);
      }
    }
  }

  async isLocked(lockFilePath: string): Promise<boolean> {
    try {
      await fs.promises.access(lockFilePath);
      return true;
    } catch {
      return false;
    }
  }

  private async lockFile(lockFilePath: string): Promise<void> {
    await fs.promises.writeFile(lockFilePath, 'locked');
  }

  private async unlockFile(lockFilePath: string): Promise<void> {
    await fs.promises.unlink(lockFilePath);
  }

  // Poll until the file is unlocked
  async pollUntilUnlocked(lockFilePath: string): Promise<void> {
    while (await this.isLocked(lockFilePath)) {
      await new Promise((resolve) => setTimeout(resolve, POLL_TIMER));
    }
  }

  async downloadAndWriteToFile(lockFilePath: string): Promise<void> {
    const bundleFilePath = path.join(
      this.tmpCacheDir,
      `bundle_${this.cachedBundleDetails.id}`,
    );

    if (await this.isLocked(lockFilePath)) {
      // no op for other workers.
      await this.pollUntilUnlocked(lockFilePath);
    } else {
      await this.lockFile(lockFilePath);

      const zippedBundleData = await this.retrieveBundleData(
        this.cachedBundleDetails.storage_id,
        BUNDLE_TIMEOUT,
      );
      // TODO: unsure if i need to use the zipper
      const unzippedBundleData = await this.unzipStorageData(
        this.cachedBundleDetails.compression_id,
        zippedBundleData.storageData,
      );

      await this.writeToFile(bundleFilePath, unzippedBundleData);

      await this.unlockFile(lockFilePath); // to lock it so other won't start reading until it is done writing
    }
  }

  async writeToFile(bundleFilePath: string, data: Buffer): Promise<void> {
    await fs.promises.writeFile(bundleFilePath, data, { flag: 'w' });
    await fs.promises.chmod(bundleFilePath, 0o444);
  }

  async readFromFile(
    bundleFilePath: string,
  ): Promise<UnZippedKyveBlockReponse[]> {
    try {
      return JSON.parse(await fs.promises.readFile(bundleFilePath, 'utf-8'));
    } catch (e) {
      throw new Error(`Failed to parse storageData. ${e}`);
    }
  }

  async clearFileCache(): Promise<void> {
    await fs.promises.unlink(
      path.join(this.tmpCacheDir, `bundle_${this.cachedBundleDetails.id}`),
    );
  }

  async getBlockByHeight(
    height: number,
  ): Promise<[BlockResponse, BlockResultsResponse]> {
    await this.updateCurrentBundleAndDetails(height);

    const blockData = await this.findBlockByHeight(height);

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
