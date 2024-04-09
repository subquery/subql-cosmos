// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import { Inject, Injectable } from '@nestjs/common';
import {
  CosmosDataSource,
  isCustomCosmosDs,
  isRuntimeCosmosDs,
} from '@subql/common-cosmos';
import { NodeConfig, DictionaryV1 as BaseDictionaryV1 } from '@subql/node-core';
import {
  DictionaryQueryEntry,
  DictionaryQueryCondition,
  DsProcessor,
} from '@subql/types-core';
import {
  CosmosBlockFilter,
  CosmosCustomHandler,
  CosmosDatasource,
  CosmosEventFilter,
  CosmosEventHandler,
  CosmosHandler,
  CosmosHandlerFilter,
  CosmosHandlerKind,
  CosmosMessageFilter,
  CosmosMessageHandler,
  CosmosRuntimeHandler,
} from '@subql/types-cosmos';
import { setWith, sortBy, uniqBy } from 'lodash';
import { SubqueryProject } from '../../../configure/SubqueryProject';
import { isBaseHandler, isCustomHandler } from '../../../utils/project';

type GetDsProcessor = (ds: CosmosDatasource) => DsProcessor<CosmosDatasource>;

export function eventFilterToQueryEntry(
  filter: CosmosEventFilter,
): DictionaryQueryEntry {
  const conditions: DictionaryQueryCondition[] = [
    {
      field: 'type',
      value: filter.type,
      matcher: 'equalTo',
    },
  ];
  if (filter.messageFilter !== undefined) {
    const messageFilter = messageFilterToQueryEntry(
      filter.messageFilter,
    ).conditions.map((f) => {
      if (f.field === 'type') {
        return { ...f, field: 'msgType' };
      }
      return f;
    });

    conditions.push(...messageFilter);
  }
  return {
    entity: 'events',
    conditions: conditions,
  };
}

function getBaseHandlerKind(
  ds: CosmosDataSource,
  handler: CosmosHandler,
  getDsProcessor: GetDsProcessor,
): CosmosHandlerKind {
  if (isRuntimeCosmosDs(ds) && isBaseHandler(handler)) {
    return (handler as CosmosRuntimeHandler).kind;
  } else if (isCustomCosmosDs(ds) && isCustomHandler(handler)) {
    const plugin = getDsProcessor(ds);
    const baseHandler = plugin.handlerProcessors[handler.kind]?.baseHandlerKind;
    if (!baseHandler) {
      throw new Error(
        `handler type ${handler.kind} not found in processor for ${ds.kind}`,
      );
    }
    return baseHandler;
  }
}

function getBaseHandlerFilters<T extends CosmosHandlerFilter>(
  ds: CosmosDataSource,
  handlerKind: string,
  getDsProcessor: GetDsProcessor,
): T[] {
  if (isCustomCosmosDs(ds)) {
    const plugin = getDsProcessor(ds);
    const processor = plugin.handlerProcessors[handlerKind];
    return processor.baseFilter instanceof Array
      ? (processor.baseFilter as T[])
      : ([processor.baseFilter] as T[]);
  } else {
    throw new Error(`Expected a custom datasource here`);
  }
}

function buildDictionaryQueryEntries(
  dataSources: CosmosDatasource[],
  getDsProcessor: GetDsProcessor,
): DictionaryQueryEntry[] {
  const queryEntries: DictionaryQueryEntry[] = [];

  for (const ds of dataSources) {
    const plugin = isCustomCosmosDs(ds) ? getDsProcessor(ds) : undefined;
    for (const handler of ds.mapping.handlers) {
      const baseHandlerKind = getBaseHandlerKind(ds, handler, getDsProcessor);
      let filterList: CosmosHandlerFilter[];
      if (isCustomCosmosDs(ds)) {
        const processor = plugin.handlerProcessors[handler.kind];
        if (processor.dictionaryQuery) {
          const queryEntry = processor.dictionaryQuery(
            (handler as CosmosCustomHandler).filter,
            ds,
          ) as DictionaryQueryEntry;
          if (queryEntry) {
            queryEntries.push(queryEntry);
            continue;
          }
        }
        filterList = getBaseHandlerFilters<CosmosHandlerFilter>(
          ds,
          handler.kind,
          getDsProcessor,
        );
      } else {
        filterList = [
          (handler as CosmosEventHandler | CosmosMessageHandler).filter,
        ];
      }
      // Filter out any undefined
      filterList = filterList.filter(Boolean);
      if (!filterList.length) return [];
      switch (baseHandlerKind) {
        case CosmosHandlerKind.Block:
          for (const filter of filterList as CosmosBlockFilter[]) {
            if (filter.modulo === undefined) {
              return [];
            }
          }
          break;
        case CosmosHandlerKind.Message: {
          for (const filter of filterList as CosmosMessageFilter[]) {
            if (filter.type !== undefined) {
              queryEntries.push(messageFilterToQueryEntry(filter));
            } else {
              return [];
            }
          }
          break;
        }
        case CosmosHandlerKind.Event: {
          for (const filter of filterList as CosmosEventFilter[]) {
            if (filter.type !== undefined) {
              queryEntries.push(eventFilterToQueryEntry(filter));
            } else {
              return [];
            }
          }
          break;
        }
        default:
      }
    }
  }

  return uniqBy(
    queryEntries,
    (item) =>
      `${item.entity}|${JSON.stringify(
        sortBy(item.conditions, (c) => c.field),
      )}`,
  );
}

export function messageFilterToQueryEntry(
  filter: CosmosMessageFilter,
): DictionaryQueryEntry {
  const conditions: DictionaryQueryCondition[] = [
    {
      field: 'type',
      value: filter.type,
      matcher: 'equalTo',
    },
  ];

  if (filter.values !== undefined) {
    const nested = {};

    // convert nested filters from `msg.swap.input_token` to { msg: { swap: { input_token: 'Token2' } } }
    Object.keys(filter.values).map((key) => {
      const value = filter.values[key];
      setWith(nested, key, value);
    });

    conditions.push({
      field: 'data',
      value: nested as any, // Cast to any for compat with node core
      matcher: 'contains',
    });
  }
  return {
    entity: 'messages',
    conditions: conditions,
  };
}

@Injectable()
export class DictionaryV1 extends BaseDictionaryV1<CosmosDatasource> {
  private constructor(
    @Inject('ISubqueryProject') protected project: SubqueryProject,
    nodeConfig: NodeConfig,
    private getDsProcessor: GetDsProcessor,
    dictionaryUrl?: string,
  ) {
    super(dictionaryUrl, project.network.chainId, nodeConfig, [
      'lastProcessedHeight',
      'chain',
    ]);
  }

  static async create(
    project: SubqueryProject,
    nodeConfig: NodeConfig,
    getDsProcessor: GetDsProcessor,
    url: string,
  ): Promise<DictionaryV1> {
    const dict = new DictionaryV1(project, nodeConfig, getDsProcessor, url);

    await dict.init();

    return dict;
  }

  buildDictionaryQueryEntries(
    // Add name to datasource as templates have this set
    dataSources: CosmosDatasource[],
  ): DictionaryQueryEntry[] {
    return buildDictionaryQueryEntries(dataSources, this.getDsProcessor);
  }
}
