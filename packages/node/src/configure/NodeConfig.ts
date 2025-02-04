// // Copyright 2020-2025 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import { SupportedChains } from '@kyvejs/sdk/src/constants';
import { IConfig, NodeConfig } from '@subql/node-core';

export interface ICosmosConfig extends IConfig {
  kyveChainId: SupportedChains;
  kyveEndpoint: string;
  kyveStorageUrl: string;
}

export class CosmosNodeConfig extends NodeConfig<ICosmosConfig> {
  /**
   * This is a wrapper around the core NodeConfig to get additional properties that are provided through args or node runner options
   * NOTE: This isn't injected anywhere, so you need to wrap the injected node config
   *
   * @example
   * constructor(
   *   nodeConfig: NodeConfig,
   * ) {
   *   this.nodeConfig = new CosmosNodeConfig(nodeConfig);
   * }
   * */
  constructor(config: NodeConfig) {
    // Rebuild with internal config
    super((config as any)._config, (config as any)._isTest);
  }

  get kyveEndpoint(): string {
    return this._config.kyveEndpoint;
  }

  get kyveChainId(): SupportedChains {
    return this._config.kyveChainId;
  }

  get kyveStorageUrl(): string {
    return this._config.kyveStorageUrl;
  }
}
