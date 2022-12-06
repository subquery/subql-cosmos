// Copyright 2020-2022 OnFinality Limited authors & contributors
// SPDX-License-Identifier: Apache-2.0

import { Inject, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ProjectNetworkV1_0_0 } from '@subql/common-avalanche';
import { ApiService, getLogger, IndexerEvent } from '@subql/node-core';
import { SubqueryProject } from '../configure/SubqueryProject';
import { AvalancheApi } from './api.avalanche';

const logger = getLogger('api');

@Injectable()
export class AvalancheApiService extends ApiService {
  constructor(
    @Inject('ISubqueryProject') project: SubqueryProject,
    private eventEmitter: EventEmitter2,
  ) {
    super(project);
  }
  private _api: AvalancheApi;

  async init(): Promise<AvalancheApiService> {
    try {
      let network: ProjectNetworkV1_0_0;
      try {
        network = this.project.network;
      } catch (e) {
        logger.error(Object.keys(e));
        process.exit(1);
      }

      this.api = new AvalancheApi(network);
      await this.api.init();
      this.networkMeta = {
        chain: this.api.getRuntimeChain(),
        specName: this.api.getSpecName(),
        genesisHash: this.api.getGenesisHash(),
      };
      this.eventEmitter.emit(IndexerEvent.ApiConnected, { value: 1 });

      // Unsure how to implement this for avalanche
      // this.api.on('connected', () => {
      //   this.eventEmitter.emit(IndexerEvent.ApiConnected, { value: 1 });
      // });
      // this.api.on('disconnected', () => {
      //   this.eventEmitter.emit(IndexerEvent.ApiConnected, { value: 0 });
      // });

      if (network.chainId !== this.api.getChainId()) {
        const err = new Error(
          `Network chainId doesn't match expected chainId. expected="${
            network.chainId
          }" actual="${this.api.getChainId()}`,
        );
        logger.error(err, err.message);
        throw err;
      }

      return this;
    } catch (e) {
      logger.error(e, 'Failed to init api service');
      process.exit(1);
    }
  }

  get api(): AvalancheApi {
    return this._api;
  }

  private set api(value: AvalancheApi) {
    this._api = value;
  }
}
