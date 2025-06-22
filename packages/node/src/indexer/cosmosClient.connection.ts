// // Copyright 2020-2025 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import { Registry } from '@cosmjs/proto-signing';
import { HttpEndpoint } from '@cosmjs/stargate';
import {
  CometClient,
  Tendermint37Client,
  Comet38Client,
  Tendermint34Client,
} from '@cosmjs/tendermint-rpc';
import {
  IBlock,
  ApiConnectionError,
  ApiErrorType,
  IApiConnectionSpecific,
  NetworkMetadataPayload,
  exitWithError,
} from '@subql/node-core';
import { getLogger } from '@subql/node-core/dist';
import { IEndpointConfig } from '@subql/types-core';
import { CosmosClient, CosmosSafeClient } from './api.service';
import { HttpClient, WebsocketClient } from './rpc-clients';
import { BlockContent } from './types';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version: packageVersion } = require('../../package.json');

const logger = getLogger('CosmosClientConnection');

/**
 * Auto-detects the version of the backend and uses a suitable client.
 */
async function connectComet(
  client: WebsocketClient | HttpClient,
): Promise<CometClient> {
  // Tendermint/CometBFT 0.34/0.37/0.38 auto-detection. Starting with 0.37 we seem to get reliable versions again 🎉
  // Using 0.34 as the fallback.
  let out: CometClient;
  const tm37Client = await Tendermint37Client.create(client);
  const version = (await tm37Client.status()).nodeInfo.version;
  if (version.startsWith('0.37.')) {
    logger.debug(`Using Tendermint 37 Client`);
    out = tm37Client;
  } else if (version.startsWith('0.38.') || version.startsWith('1.0.')) {
    tm37Client.disconnect();
    logger.debug(`Using Comet 38 Client`);
    out = await Comet38Client.create(client);
  } else {
    tm37Client.disconnect();
    logger.debug(`Using Tendermint 34 Client`);
    out = await Tendermint34Client.create(client);
  }
  return out;
}

type FetchFunc = (
  api: CosmosClient,
  batch: number[],
) => Promise<IBlock<BlockContent>[]>;

export class CosmosClientConnection
  implements
    IApiConnectionSpecific<
      CosmosClient,
      CosmosSafeClient,
      IBlock<BlockContent>[]
    >
{
  readonly networkMeta: NetworkMetadataPayload;

  private constructor(
    public unsafeApi: CosmosClient,
    private fetchBlocksBatches: FetchFunc,
    chainId: string,
    private cometClient: CometClient,
    private registry: Registry,
  ) {
    this.networkMeta = {
      chain: chainId,
      specName: undefined as any,
      genesisHash: undefined as any, // Cant always get the genesis hash because of pruning
    };
  }

  static async create(
    endpoint: string,
    fetchBlocksBatches: FetchFunc,
    registry: Registry,
    config: IEndpointConfig,
  ): Promise<CosmosClientConnection> {
    const httpEndpoint: HttpEndpoint = {
      url: endpoint,
      headers: {
        'User-Agent': `SubQuery-Node ${packageVersion}`,
        ...config.headers,
      },
    };

    const rpcClient =
      endpoint.includes('ws://') || endpoint.includes('wss://')
        ? new WebsocketClient(endpoint, (err) => {
            exitWithError(
              new Error(`Websocket connection failed`, { cause: err }),
              logger,
            );
          })
        : new HttpClient(httpEndpoint);

    const cometClient = await connectComet(rpcClient);

    const api = new CosmosClient(cometClient, registry);

    const connection = new CosmosClientConnection(
      api,
      fetchBlocksBatches,
      await api.getChainId(),
      cometClient,
      registry,
    );

    logger.info(`connected to ${endpoint}`);

    return connection;
  }

  safeApi(height: number): CosmosSafeClient {
    return new CosmosSafeClient(this.cometClient, height);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async apiConnect(): Promise<void> {
    this.unsafeApi = new CosmosClient(this.cometClient, this.registry);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async apiDisconnect(): Promise<void> {
    this.unsafeApi.disconnect();
  }

  async fetchBlocks(heights: number[]): Promise<IBlock<BlockContent>[]> {
    const blocks = await this.fetchBlocksBatches(this.unsafeApi, heights);
    return blocks;
  }

  handleError = CosmosClientConnection.handleError;

  static handleError(e: Error): ApiConnectionError {
    let formatted_error: ApiConnectionError;
    if (e.message.startsWith(`No response received from RPC endpoint in`)) {
      formatted_error = CosmosClientConnection.handleTimeoutError(e);
    } else if (e.message.startsWith(`disconnected from `)) {
      formatted_error = CosmosClientConnection.handleDisconnectionError(e);
    } else if (e.message.startsWith(`Request failed with status code 429`)) {
      formatted_error = CosmosClientConnection.handleRateLimitError(e);
    } else if (e.message.includes(`Exceeded max limit of`)) {
      formatted_error = CosmosClientConnection.handleLargeResponseError(e);
    } else {
      formatted_error = new ApiConnectionError(
        e.name,
        e.message,
        ApiErrorType.Default,
      );
    }
    return formatted_error;
  }

  static handleRateLimitError(e: Error): ApiConnectionError {
    return new ApiConnectionError(
      'RateLimit',
      e.message,
      ApiErrorType.RateLimit,
    );
  }

  static handleTimeoutError(e: Error): ApiConnectionError {
    return new ApiConnectionError(
      'TimeoutError',
      e.message,
      ApiErrorType.Timeout,
    );
  }

  static handleDisconnectionError(e: Error): ApiConnectionError {
    return new ApiConnectionError(
      'ConnectionError',
      e.message,
      ApiErrorType.Connection,
    );
  }

  static handleLargeResponseError(e: Error): ApiConnectionError {
    const newMessage = `Oversized RPC node response. This issue is related to the network's RPC nodes configuration, not your application. You may report it to the network's maintainers or try a different RPC node.\n\n${e.message}`;

    return new ApiConnectionError(
      'RpcInternalError',
      newMessage,
      ApiErrorType.Default,
    );
  }
}
