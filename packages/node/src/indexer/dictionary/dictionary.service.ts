// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import { Inject, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NETWORK_FAMILY } from '@subql/common';
import {
  NodeConfig,
  DictionaryService as BaseDictionaryService,
  getLogger,
} from '@subql/node-core';
import { CosmosDatasource } from '@subql/types-cosmos';
import { SubqueryProject } from '../../configure/SubqueryProject';
import { DsProcessorService } from '../ds-processor.service';
import { BlockContent } from '../types';
import { DictionaryV1 } from './v1';

const logger = getLogger('DictionaryService');

@Injectable()
export class DictionaryService extends BaseDictionaryService<
  CosmosDatasource,
  BlockContent
> {
  constructor(
    @Inject('ISubqueryProject') protected project: SubqueryProject,
    nodeConfig: NodeConfig,
    protected dsProcessorService: DsProcessorService,
    eventEmitter: EventEmitter2,
  ) {
    super(project.network.chainId, nodeConfig, eventEmitter);
  }

  async initDictionaries(): Promise<void> {
    const dictionariesV1: DictionaryV1[] = [];

    if (!this.project) {
      throw new Error(`Project in Dictionary service not initialized `);
    }

    const dictionaryEndpoints = await this.getDictionaryEndpoints(
      NETWORK_FAMILY.cosmos,
      this.project.network,
    );

    for (const endpoint of dictionaryEndpoints) {
      try {
        const dictionary = await DictionaryV1.create(
          this.project,
          this.nodeConfig,
          this.dsProcessorService.getDsProcessor.bind(this.dsProcessorService),
          endpoint,
        );
        dictionariesV1.push(dictionary);
      } catch (e) {
        logger.warn(
          `Dictionary endpoint "${endpoint}" is not a valid dictionary`,
        );
      }
    }
    // v2 should be prioritised
    this.init(dictionariesV1);
  }
}
