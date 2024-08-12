// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import { CosmWasmClient, IndexedTx } from '@cosmjs/cosmwasm-stargate';
import { toHex } from '@cosmjs/encoding';
import { Uint53 } from '@cosmjs/math';
import { GeneratedType, Registry } from '@cosmjs/proto-signing';
import { Block, defaultRegistryTypes, SearchTxQuery } from '@cosmjs/stargate';
import { CometClient, toRfc3339WithNanoseconds } from '@cosmjs/tendermint-rpc';
import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CosmosProjectNetConfig } from '@subql/common-cosmos';
import {
  ApiService as BaseApiService,
  ConnectionPoolService,
  getLogger,
  IBlock,
  NodeConfig,
} from '@subql/node-core';
import { CosmWasmSafeClient } from '@subql/types-cosmos/interfaces';
import {
  MsgClearAdmin,
  MsgExecuteContract,
  MsgInstantiateContract,
  MsgMigrateContract,
  MsgStoreCode,
  MsgUpdateAdmin,
} from 'cosmjs-types/cosmwasm/wasm/v1/tx';
import { CosmosNodeConfig } from '../configure/NodeConfig';
import { SubqueryProject } from '../configure/SubqueryProject';
import * as CosmosUtil from '../utils/cosmos';
import { KyveApi } from '../utils/kyve/kyve';
import { CosmosClientConnection } from './cosmosClient.connection';
import { BlockContent, BlockResponse, BlockResultsResponse } from './types';

const logger = getLogger('api');

const MAX_RECONNECT_ATTEMPTS = 5;
const KYVE_BUFFER_RANGE = 10;

@Injectable()
export class ApiService
  extends BaseApiService<CosmosClient, CosmosSafeClient, IBlock<BlockContent>[]>
  implements OnApplicationShutdown
{
  private fetchBlocksBatches = CosmosUtil.fetchBlocksBatches;
  private nodeConfig: CosmosNodeConfig;
  private kyveApi?: KyveApi;
  registry: Registry;

  constructor(
    @Inject('ISubqueryProject') private project: SubqueryProject,
    connectionPoolService: ConnectionPoolService<CosmosClientConnection>,
    eventEmitter: EventEmitter2,
    nodeConfig: NodeConfig,
  ) {
    super(connectionPoolService, eventEmitter);
    this.nodeConfig = new CosmosNodeConfig(nodeConfig);
  }

  private async buildRegistry(): Promise<Registry> {
    const chaintypes = await this.getChainType(this.project.network);

    const wasmTypes: ReadonlyArray<[string, GeneratedType]> = [
      ['/cosmwasm.wasm.v1.MsgClearAdmin', MsgClearAdmin],
      ['/cosmwasm.wasm.v1.MsgExecuteContract', MsgExecuteContract],
      ['/cosmwasm.wasm.v1.MsgMigrateContract', MsgMigrateContract],
      ['/cosmwasm.wasm.v1.MsgStoreCode', MsgStoreCode],
      ['/cosmwasm.wasm.v1.MsgInstantiateContract', MsgInstantiateContract],
      ['/cosmwasm.wasm.v1.MsgUpdateAdmin', MsgUpdateAdmin],
    ];

    const registry = new Registry([...defaultRegistryTypes, ...wasmTypes]);

    for (const typeurl in chaintypes) {
      registry.register(typeurl, chaintypes[typeurl]);
    }

    return registry;
  }

  async onApplicationShutdown(): Promise<void> {
    await this.connectionPoolService.onApplicationShutdown();
  }

  async init(): Promise<ApiService> {
    const { network } = this.project;

    this.registry = await this.buildRegistry();

    await this.createConnections(network, (endpoint, config) =>
      CosmosClientConnection.create(
        endpoint,
        this.fetchBlocksBatches,
        this.registry,
        config,
      ),
    );

    if (
      this.nodeConfig.kyveEndpoint &&
      this.nodeConfig.kyveEndpoint !== 'false'
    ) {
      try {
        this.kyveApi = await KyveApi.create(
          network.chainId,
          this.nodeConfig.kyveEndpoint,
          this.nodeConfig.kyveStorageUrl,
          this.nodeConfig.kyveChainId,
          this.project.tempDir,
          KYVE_BUFFER_RANGE * this.nodeConfig.batchSize,
        );
      } catch (e) {
        logger.warn(`Kyve Api is not connected. ${e}`);
      }
    } else {
      logger.info(`Kyve not connected`);
    }

    return this;
  }

  // Overrides the super function because of the kyve integration
  async fetchBlocks(
    heights: number[],
    numAttempts = MAX_RECONNECT_ATTEMPTS,
  ): Promise<IBlock<BlockContent>[]> {
    return this.retryFetch(async () => {
      if (this.kyveApi) {
        try {
          return await this.kyveApi.fetchBlocksBatches(this.registry, heights);
        } catch (e) {
          logger.warn(
            e,
            `Failed to fetch blocks: ${JSON.stringify(
              heights,
            )} via Kyve, trying with RPC`,
          );
        }
      }
      // Get the latest fetch function from the provider
      const apiInstance = this.connectionPoolService.api;
      return apiInstance.fetchBlocks(heights);
    }, numAttempts);
  }

  get api(): CosmosClient {
    return this.unsafeApi;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getSafeApi(height: number): Promise<CosmosSafeClient> {
    return this.connectionPoolService.api.safeApi(height);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async getChainType(
    network: Partial<CosmosProjectNetConfig>,
  ): Promise<Record<string, GeneratedType>> {
    if (!network.chaintypes) {
      return {};
    }

    const res: Record<string, GeneratedType> = {};
    for (const [
      userPackageName,
      { messages, packageName },
    ] of network.chaintypes) {
      const pkgName = packageName ?? userPackageName;
      for (const msg of messages) {
        logger.info(`Registering chain message type "/${pkgName}.${msg}"`);
        const msgObj = network.chaintypes.protoRoot.lookupTypeOrEnum(
          `${pkgName}.${msg}`,
        );
        res[`/${pkgName}.${msg}`] = msgObj;
      }
    }
    return res;
  }
}

export class CosmosClient extends CosmWasmClient {
  constructor(
    private readonly _cometClient: CometClient,
    public registry: Registry,
  ) {
    super(_cometClient);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async blockInfo(height?: number): Promise<BlockResponse> {
    return this._cometClient.block(height);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async txInfoByHeight(height: number): Promise<readonly IndexedTx[]> {
    return this.searchTx(`tx.height=${height}`);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async blockResults(height: number): Promise<BlockResultsResponse> {
    return this._cometClient.blockResults(height);
  }

  static handleError(e: Error): Error {
    const formatted_error: Error = e;
    try {
      const message = JSON.parse(e.message);
      if (
        message.data &&
        message.data.includes(`is not available, lowest height is`)
      ) {
        formatted_error.message = `${message.data}\nINFO: This most likely means the provided endpoint is a pruned node. An archive/full node is needed to access historical data`;
      }
    } catch (err) {
      if (e.message === 'Request failed with status code 429') {
        formatted_error.name = 'RateLimitError';
      } else if (e.message === 'Request failed with status code 403') {
        formatted_error.name = 'Forbidden';
      }
    }
    return formatted_error;
  }
}

// TODO make this class not exported and expose interface instead
export class CosmosSafeClient
  extends CosmWasmClient
  implements CosmWasmSafeClient
{
  height: number;

  constructor(cometClient: CometClient, height: number) {
    super(cometClient);
    this.height = height;
  }

  // Deprecate
  async getBlock(): Promise<Block> {
    const response = await this.forceGetCometClient().block(this.height);
    return {
      id: toHex(response.blockId.hash).toUpperCase(),
      header: {
        version: {
          block: new Uint53(response.block.header.version.block).toString(),
          app: new Uint53(response.block.header.version.app).toString(),
        },
        height: response.block.header.height,
        chainId: response.block.header.chainId,
        time: toRfc3339WithNanoseconds(response.block.header.time),
      },
      txs: response.block.txs,
    };
  }

  async validators(): Promise<
    Awaited<ReturnType<CometClient['validators']>>['validators']
  > {
    return (
      await this.forceGetCometClient().validators({
        height: this.height,
      })
    ).validators;
  }

  async searchTx(query: SearchTxQuery): Promise<IndexedTx[]> {
    const txs: IndexedTx[] = await this.safeTxsQuery(
      `tx.height=${this.height}`,
    );
    return txs;
  }

  private async safeTxsQuery(query: string): Promise<IndexedTx[]> {
    const results = await this.forceGetCometClient().txSearchAll({
      query: query,
    });
    return results.txs.map((tx) => {
      return {
        txIndex: tx.index,
        height: tx.height,
        hash: toHex(tx.hash).toUpperCase(),
        code: tx.result.code,
        rawLog: tx.result.log || '',
        tx: tx.tx,
        gasUsed: tx.result.gasUsed,
        gasWanted: tx.result.gasWanted,
        msgResponses: [], // TODO can we get these?
        events: tx.result.events.map((evt) => ({
          ...evt,
          attributes: evt.attributes.map((attr) => ({
            key: Buffer.from(attr.key).toString('utf8'),
            value: Buffer.from(attr.value).toString('utf8'),
          })),
        })),
      };
    });
  }
}
