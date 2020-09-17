import {debug as Debug} from 'https://deno.land/x/debug/mod.ts'
import type {Meta} from './Meta.ts'

import type {
  AnyJson,
  PayloadSubscription,
  PayloadAndSubscription,
  onPayloadEvent,
  CreatePayload,
  CreatedPayload,
  DeletedPayload,
  XummPayload
} from './types/index.ts'

import {
  throwIfError,
  DeferredPromise
} from './utils.ts'

const log = Debug('xumm-sdk:payload')
const logWs = Debug('xumm-sdk:payload:websocket')

export class Payload {
  private Meta: Meta

  constructor (MetaObject: Meta) {
    log('Constructed')

    this.Meta = MetaObject
  }

  async resolvePayload(payload: string | XummPayload | CreatedPayload): Promise<XummPayload | null> {
    if (typeof payload === 'string') {
      return await this.get(payload, true)
    } else if (typeof (payload as CreatedPayload)?.uuid !== 'undefined') {
      return await this.get((payload as CreatedPayload).uuid, true)
    } else if (typeof (payload as XummPayload)?.meta?.uuid !== 'undefined') {
      return (payload as XummPayload)
    }

    throw new Error('Could not resolve payload (not found)')
  }

  async create (payload: CreatePayload, returnErrors: boolean = false): Promise<CreatedPayload | null> {
    const call = await this.Meta.call<CreatedPayload>('payload', 'POST', payload)
    if (returnErrors) {
      throwIfError(call)
    }

    const isCreatedPayload = (call as unknown as CreatedPayload)?.next !== undefined
    if (!isCreatedPayload) {
      return null
    }

    return call
  }

  async get (payload: string | CreatedPayload, returnErrors: boolean = false): Promise<XummPayload | null> {
    const payloadUuid = typeof payload === 'string'
     ? payload
     : payload?.uuid

    const call = await this.Meta.call<XummPayload>('payload/' + payloadUuid, 'GET')

    if (returnErrors) {
      throwIfError(call)
    }

    const isPayload = (call as unknown as XummPayload)?.meta?.uuid !== undefined
    if (!isPayload) {
      return null
    }

    return call
  }

  async subscribe (
    payload: string | XummPayload | CreatedPayload,
    callback?: onPayloadEvent
  ): Promise<PayloadSubscription> {
    const callbackPromise = new DeferredPromise()

    /**
     * This is ugly, but there's a small chance a created XUMM payload has not been distributed
     * across the load balanced XUMM backend, so wait a bit.
     */
    await new Promise(resolve => setTimeout(resolve, 75))

    const payloadDetails = await this.resolvePayload(payload)

    if (payloadDetails) {
      const socket = new WebSocket('wss://xumm.app/sign/' + payloadDetails.meta.uuid)

      callbackPromise.promise.then(() => {
        socket.close()
      })

      socket.onopen = () => {
        logWs(`Payload ${payloadDetails.meta.uuid}: Subscription active (WebSocket opened)`)
      }

      socket.onmessage = async (MessageEvent: any) => {
        const m = MessageEvent.data
        let json: AnyJson | undefined = undefined

        try {
          json = JSON.parse(m.toString())
        } catch (e) {
          // Do nothing
          logWs(`Payload ${payloadDetails.meta.uuid}: Received message, unable to parse as JSON`, e)
        }

        if (json && callback && typeof json.devapp_fetched === 'undefined') {
          try {
            // log(`Payload ${payload}`, json)

            const callbackResult = await callback({
              uuid: payloadDetails.meta.uuid,
              data: json,
              async resolve (resolveData?: any) {
                callbackPromise.resolve(resolveData || undefined)
              },
              payload: payloadDetails
            })

            if (callbackResult !== undefined) {
              callbackPromise.resolve(callbackResult)
            }
          } catch (e) {
            // Do nothing
            logWs(`Payload ${payloadDetails.meta.uuid}: Callback exception`, e)
          }
        }
      }

      socket.onclose = (e: any) => {
        logWs(`Payload ${payloadDetails.meta.uuid}: Subscription ended (WebSocket closed)`)
      }

      return {
        payload: payloadDetails,
        resolve (resolveData?: any) {
          callbackPromise.resolve(resolveData || undefined)
        },
        resolved: callbackPromise.promise,
        websocket: socket
      }
    }

    throwIfError(payloadDetails)

    throw Error(`Couldn't subscribe: couldn't fetch payload`)
  }

  async cancel (
    payload: string | XummPayload | CreatedPayload,
    returnErrors: boolean = false
  ): Promise<DeletedPayload | null> {
    const fullPayload = await this.resolvePayload(payload)

    const call = await this.Meta.call<DeletedPayload>('payload/' + fullPayload?.meta?.uuid, 'DELETE')
    if (returnErrors) {
      throwIfError(call)
    }

    const isValidResponse = (call as unknown as DeletedPayload)?.meta?.uuid !== undefined
    if (!isValidResponse) {
      return null
    }

    return call
  }

  async createAndSubscribe (
    payload: CreatePayload,
    callback?: onPayloadEvent
  ): Promise<PayloadAndSubscription> {
    const createdPayload = await this.create(payload, true)
    if (createdPayload) {
      const subscription = await this.subscribe(createdPayload, callback)
      return {
        created: createdPayload,
        ...subscription
      }
    }
    throw new Error(`Error creating payload or subscribing to created payload`)
  }

  /**
   * TODO: add xrpl.ws helper WebSocket client to verify payload result tx hash
   * on ledger.
   */

  // async getPayloadXrplTx (payload: string | XummPayload | CreatedPayload): Promise<AnyJson | null> {
  //   // TODO
  // }

}
