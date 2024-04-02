// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import { IConfig, NodeConfig } from '@subql/node-core';

export interface ICosmosConfig extends IConfig {
  kyve: string;
}

export class CosmosNodeConfig extends NodeConfig<ICosmosConfig> {
  /**
   * This is a wrapper around the core NodeConfig to get additional properties that are provided through args or node runner options
   * NOTE: This isn't injected anywhere so you need to wrap the injected node config
   *
   * @example
   * constructor(
   *   nodeConfig: NodeConfig,
   * ) {
   *   this.nodeConfig = new EthereumNodeConfig(nodeConfig);
   * }
   * */
  constructor(config: NodeConfig) {
    // Rebuild with internal config
    super((config as any)._config, (config as any)._isTest);
  }

  get kyve(): string {
    return this._config.kyve;
  }
}
