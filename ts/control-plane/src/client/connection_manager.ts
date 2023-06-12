/* eslint-disable @typescript-eslint/no-non-null-assertion */
import "ix/add/asynciterable-operators/first";
import "ix/add/asynciterable-operators/finalize";
import "ix/add/asynciterable-operators/last";

import { throwExpression } from "@mrc/common/utils";

import { MrcTestClient } from "@mrc/client/client";
import {
   ControlPlaneState,
   ManifoldInstance,
   PipelineInstance,
   ResourceActualStatus,
   SegmentInstance,
} from "@mrc/proto/mrc/protos/architect_state";
import { as, AsyncSink } from "ix/asynciterable";

import { generateId, packEvent, unpackEvent } from "@mrc/common/utils";
import {
   ClientConnectedResponse,
   Event,
   EventType,
   ResourceUpdateStatusRequest,
   ResourceUpdateStatusResponse,
} from "@mrc/proto/mrc/protos/architect";

import { unpack_first_event, unpack_unary_event } from "@mrc/client/utils";
import { UnknownMessage } from "@mrc/proto/typeRegistry";
import { Observable, filter, from, share, tap } from "rxjs";

export class ConnectionManager {
   private _client: MrcTestClient;
   private _isCreated = false;
   private _isRegistered = false;

   private _abort_controller: AbortController = new AbortController();
   private _send_events: AsyncSink<Event> | null = null;
   private _receive_events$: Observable<Event> | null = null;
   private _machineId: string | null = null;

   private _state_updates: Array<ControlPlaneState> = [];
   private _message_history: Array<Event> = [];

   private _response_stream$: Observable<Event> | null = null;
   private _receive_events_complete: Promise<void> | null = null;

   constructor(client?: MrcTestClient) {
      if (!client) {
         client = new MrcTestClient();
      }

      this._client = client;
   }

   get client() {
      return this._client;
   }

   get isRegistered() {
      return this._isRegistered;
   }

   get isCreated() {
      return this._isCreated;
   }

   get machineId() {
      return this._machineId ?? throwExpression("Must register first");
   }

   public getClientState() {
      if (this._state_updates.length === 0) {
         throw new Error("Cant get client state. No state updates have been received");
      }

      return this._state_updates[this._state_updates.length - 1];
   }

   public async register() {
      if (this.isRegistered) {
         throw new Error("Already registered");
      }

      await this._client.ensureClientInitialized();

      this._abort_controller = new AbortController();
      this._send_events = new AsyncSink<Event>();

      const receive_events = as(
         this._client.client!.eventStream(this._send_events, {
            signal: this._abort_controller.signal,
         })
      );

      this._receive_events$ = from(receive_events).pipe(
         tap((event) => {
            // Save a history of the messages to help with debugging
            this._message_history.push(event);
         }),
         share()
      );

      // Subscribe permenantly to keep the stream hot
      this._receive_events_complete = this._receive_events$
         .pipe(
            filter((value) => {
               return value.event === EventType.ServerStateUpdate;
            })
         )
         .forEach((value: Event) => {
            // Save all of the server state updates
            this._state_updates.push(unpackEvent<ControlPlaneState>(value));
         });

      this._response_stream$ = this._receive_events$;

      this._isRegistered = true;
   }

   public async ensureRegistered() {
      if (!this.isRegistered) {
         await this.register();
      }
   }

   public async unregister() {
      if (!this.isRegistered) {
         throw new Error("Must be registered first");
      }

      if (this._send_events) {
         this._send_events.end();
         this._send_events = null;
      }

      // Need to await for all events to flush through
      if (this._receive_events_complete) {
         await this._receive_events_complete;
         this._receive_events_complete = null;
      }

      this._isRegistered = false;
   }

   public async createResources() {
      if (this.isCreated) {
         throw new Error("Already created");
      }

      await this.ensureRegistered();

      // Wait for the connected response before filtering off the state update
      const connected_response = await unpack_first_event<ClientConnectedResponse>(
         this._receive_events$!,
         (event) => event.event === EventType.ClientEventStreamConnected
      );

      this._machineId = connected_response.machineId;

      this._isCreated = true;
   }

   public async ensureResourcesCreated() {
      await this.ensureRegistered();

      if (!this.isCreated) {
         await this.createResources();
      }
   }

   public async send_request<ResponseT extends UnknownMessage>(event_type: EventType, request: UnknownMessage) {
      if (!this._response_stream$ || !this._send_events) {
         throw new Error("Client is not connected");
      }

      // Pack message with random tag
      const message = packEvent(event_type, generateId().toString(), request);

      return await unpack_unary_event<ResponseT>(this._response_stream$, this._send_events, message);
   }

   public async update_resource_status(
      id: string,
      resource_type: "PipelineInstances",
      status: ResourceActualStatus
   ): Promise<PipelineInstance | null>;
   public async update_resource_status(
      id: string,
      resource_type: "SegmentInstances",
      status: ResourceActualStatus
   ): Promise<SegmentInstance | null>;
   public async update_resource_status(
      id: string,
      resource_type: "ManifoldInstances",
      status: ResourceActualStatus
   ): Promise<ManifoldInstance | null>;
   public async update_resource_status(
      id: string,
      resource_type: "PipelineInstances" | "SegmentInstances" | "ManifoldInstances",
      status: ResourceActualStatus
   ) {
      const response = await this.send_request<ResourceUpdateStatusResponse>(
         EventType.ClientUnaryResourceUpdateStatus,
         ResourceUpdateStatusRequest.create({
            resourceId: id,
            resourceType: resource_type,
            status: status,
         })
      );

      // Now return the correct instance from the updated state
      if (resource_type === "PipelineInstances") {
         const entities = this.getClientState().pipelineInstances!.entities;

         if (!(id in entities)) {
            return null;
         }

         return entities[id];
      } else if (resource_type === "SegmentInstances") {
         const entities = this.getClientState().segmentInstances!.entities;

         if (!(id in entities)) {
            return null;
         }

         return entities[id];
      } else if (resource_type === "ManifoldInstances") {
         const entities = this.getClientState().manifoldInstances!.entities;

         if (!(id in entities)) {
            return null;
         }

         return entities[id];
      } else {
         throw new Error("Unknow resource type");
      }
   }
}
