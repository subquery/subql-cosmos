// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import {CosmWasmClient} from '@cosmjs/cosmwasm-stargate';
import {DecodedTxRaw} from '@cosmjs/proto-signing';
import {Log} from '@cosmjs/stargate/build/logs';
import type {tendermint34, tendermint37, comet38} from '@cosmjs/tendermint-rpc';
import Long from 'long';

export type Block = tendermint34.Block | tendermint37.Block | comet38.Block;
export type BlockId = tendermint34.BlockId | tendermint37.BlockId | comet38.BlockId;
export type Validator = tendermint34.Validator | tendermint37.Validator | comet38.Validator;
export type TxData = tendermint34.TxData | tendermint37.TxData | comet38.TxData;
export type TxEvent = tendermint34.Event | tendermint37.Event | comet38.Event;
export type Header = tendermint34.Header | tendermint37.Header | comet38.Header;

export interface CosmWasmSafeClient extends CosmWasmClient {
  validators: () => Promise<readonly Validator[]>;
}

export interface CosmosBlock {
  blockId: BlockId;
  block: {id: string} & Block;
  header: Header; // Full header
  txs: TxData[];
}

export interface CosmosTransaction {
  idx: number;
  block: CosmosBlock;
  hash: string;
  tx: TxData;
  decodedTx: DecodedTxRaw;
}

export interface CosmosMessage<T = any> {
  /**
   * The index of the message within the transaction
   */
  idx: number;
  block: CosmosBlock;
  tx: CosmosTransaction;
  msg: {
    typeUrl: string;
    decodedMsg: T;
  };
}

export enum CosmosEventKind {
  BeginBlock = 'begin_block',
  EndBlock = 'end_block',
  FinalizeBlock = 'finalize_block',
  Message = 'message',
  Transaction = 'transaction',
}

export interface CosmosEvent {
  idx: number;
  block: CosmosBlock;
  // tx and msg are optional because this is a shared interface that is use with begin, end and finalize block events.
  tx?: CosmosTransaction;
  msg?: CosmosMessage;
  log: Log;
  event: TxEvent;
  kind: CosmosEventKind;
}

export type DynamicDatasourceCreator = (name: string, args: Record<string, unknown>) => Promise<void>;

export interface Coin {
  denom: string;
  amount: string;
}

export interface MsgExecuteContract<T> {
  /** Sender is the that actor that signed the messages */
  sender: string;
  /** Contract is the address of the smart contract */
  contract: string;
  /** Msg json encoded message to be passed to the contract */
  msg: T;
  /** Funds coins that are transferred to the contract on execution */
  funds: Coin[];
}

export interface MsgMigrateContract<T> {
  /** Sender is the that actor that signed the messages */
  sender: string;
  /** Contract is the address of the smart contract */
  contract: string;
  /** CodeID references the new WASM code */
  codeId: Long;
  /** Msg json encoded message to be passed to the contract on migration */
  msg: T;
}

export interface MsgInstantiateContract<T> {
  /** Sender is the that actor that signed the messages */
  sender: string;
  /** Admin is an optional address that can execute migrations */
  admin: string;
  /** CodeID is the reference to the stored WASM code */
  codeId: Long;
  /** Label is optional metadata to be stored with a contract instance. */
  label: string;
  /** Msg json encoded message to be passed to the contract on instantiation */
  msg: T;
  /** Funds coins that are transferred to the contract on instantiation */
  funds: Coin[];
}
