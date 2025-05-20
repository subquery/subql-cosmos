// Copyright 2020-2025 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import { Module } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  ForceCleanService,
  ReindexService,
  StoreService,
  PoiService,
  storeModelFactory,
  NodeConfig,
  ConnectionPoolStateManager,
  ConnectionPoolService,
  DsProcessorService,
  DynamicDsService,
  UnfinalizedBlocksService,
  MultiChainRewindService,
} from '@subql/node-core';
import { Sequelize } from '@subql/x-sequelize';
import { BlockchainService } from '../blockchain.service';
import { ApiService } from '../indexer/api.service';

@Module({
  providers: [
    {
      provide: 'IStoreModelProvider',
      useFactory: storeModelFactory,
      inject: [NodeConfig, EventEmitter2, Sequelize],
    },
    StoreService,
    ReindexService,
    PoiService,
    ForceCleanService,
    {
      provide: 'UnfinalizedBlocksService',
      useClass: UnfinalizedBlocksService,
    },
    {
      provide: 'DynamicDsService',
      useClass: DynamicDsService,
    },
    DsProcessorService,
    ConnectionPoolStateManager,
    ConnectionPoolService,
    {
      provide: 'APIService',
      useFactory: ApiService.create.bind(ApiService),
      inject: [
        'ISubqueryProject',
        ConnectionPoolService,
        EventEmitter2,
        NodeConfig,
      ],
    },
    {
      provide: 'IBlockchainService',
      useClass: BlockchainService,
    },
    MultiChainRewindService,
  ],
  controllers: [],
})
export class ReindexFeatureModule {}
