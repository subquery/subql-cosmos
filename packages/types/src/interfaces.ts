// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import {CosmWasmClient} from '@cosmjs/cosmwasm-stargate';
import {DecodedTxRaw} from '@cosmjs/proto-signing';
import {Event} from '@cosmjs/stargate';
import {Log} from '@cosmjs/stargate/build/logs';
import {Validator, TxData, Block, BlockId, Header} from '@cosmjs/tendermint-rpc/build/tendermint37';
import Long from 'long';

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

export interface CosmosEvent {
  idx: number;
  block: CosmosBlock;
  tx: CosmosTransaction;
  msg: CosmosMessage;
  log: Log;
  event: Event;
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
