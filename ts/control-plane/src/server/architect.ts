import { ServerDuplexStream } from "@grpc/grpc-js";
import { IExecutor, IWorker } from "@mrc/common/entities";
import {
   segmentInstancesRequestStop,
   segmentInstancesSelectById,
   segmentInstancesUpdateResourceActualState,
} from "@mrc/server/store/slices/segmentInstancesSlice";
import { systemStartRequest, systemStopRequest } from "@mrc/server/store/slices/systemSlice";
import { as, AsyncSink, merge } from "ix/asynciterable";
import { withAbort } from "ix/asynciterable/operators";
import { CallContext } from "nice-grpc";
import { firstValueFrom, Subject } from "rxjs";

import {
   ensureError,
   generateId,
   pack,
   packEvent,
   sleep,
   unpackEvent,
   yield_immediate,
   yield_timeout,
} from "@mrc/common/utils";
import { Any } from "@mrc/proto/google/protobuf/any";
import {
   Ack,
   ArchitectServiceImplementation,
   ClientConnectedResponse,
   ErrorCode,
   Event,
   EventType,
   eventTypeToJSON,
   ManifoldUpdateActualAssignmentsRequest,
   ManifoldUpdateActualAssignmentsResponse,
   PingRequest,
   PingResponse,
   PipelineAddMappingRequest,
   PipelineAddMappingResponse,
   PipelineRegisterConfigRequest,
   PipelineRegisterConfigResponse,
   RegisterWorkersRequest,
   RegisterWorkersResponse,
   ResourceStopResponse,
   ResourceUpdateStatusRequest,
   ResourceUpdateStatusResponse,
   ServerStreamingMethodResult,
   ShutdownRequest,
   ShutdownResponse,
   StateUpdate,
   TaggedInstance,
} from "@mrc/proto/mrc/protos/architect";
import {
   ControlPlaneState,
   ResourceActualStatus,
   ResourceRequestedStatus,
} from "@mrc/proto/mrc/protos/architect_state";
import { DeepPartial, UnknownMessage, messageTypeRegistry } from "@mrc/proto/typeRegistry";

import {
   connectionsAdd,
   connectionsDropOne,
   connectionsSelectById,
   connectionsUpdateResourceActualState,
} from "@mrc/server/store/slices/connectionsSlice";
import {
   pipelineInstancesAdd,
   pipelineInstancesSelectById,
   pipelineInstancesUpdateResourceActualState,
} from "@mrc/server/store/slices/pipelineInstancesSlice";
import {
   workersAddMany,
   workersRemove,
   workersSelectById,
   workersSelectByMachineId,
   workersUpdateResourceActualState,
} from "@mrc/server/store/slices/workersSlice";
import { getRootStore, RootStore, stopAction } from "@mrc/server/store/store";
import {
   manifoldInstancesSelectById,
   manifoldInstancesUpdateActualSegments,
   manifoldInstancesUpdateResourceActualState,
} from "@mrc/server/store/slices/manifoldInstancesSlice";
import {
   pipelineDefinitionsCreateOrUpdate,
   pipelineDefinitionsSetMapping,
} from "@mrc/server/store/slices/pipelineDefinitionsSlice";
import { PipelineInstance } from "@mrc/common/models/pipeline_instance";
import { Executor } from "@mrc/common/models/executor";
import { Mutex } from "async-mutex";

interface IncomingData {
   msg: Event;
   stream?: ServerDuplexStream<Event, Event>;
   machineId: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function unaryResponse<MessageDataT extends UnknownMessage>(
   event: IncomingData | undefined,
   data: MessageDataT
): Event {
   // Lookup message type
   const type_registry = messageTypeRegistry.get(data.$type);

   if (!type_registry) {
      throw new Error("Unknown type");
   }

   const response = type_registry.fromPartial(data);

   const any_msg = Any.create({
      typeUrl: `type.googleapis.com/${data.$type}`,
      value: type_registry.encode(response).finish(),
   });

   return Event.create({
      event: EventType.Response,
      tag: event?.msg.tag ?? "0",
      message: any_msg,
   });
}

// function pack<MessageDataT extends UnknownMessage>(data: MessageDataT): Any {

//    // Load the type from the registry
//    const message_type = messageTypeRegistry.get(data.$type);

//    if (!message_type) {
//       throw new Error("Unknown type in type registry");
//    }

//    const any_msg = Any.create({
//       typeUrl: `type.googleapis.com/${message_type.$type}`,
//       value: message_type.encode(data).finish(),
//    });

//    return any_msg;
// }

// function unpack<MessageT extends UnknownMessage>(event: IncomingData) {
//    const message_type_str = event.msg.message?.typeUrl.split('/').pop();

//    // Load the type from the registry
//    const message_type = messageTypeRegistry.get(message_type_str ?? "");

//    if (!message_type) {
//       throw new Error(`Could not unpack message with type: ${event.msg.message?.typeUrl}`);
//    }

//    const message = message_type.decode(event.msg.message?.value as Uint8Array) as MessageT;

//    return message;
// }

// function unaryResponse<MessageDataT extends Message>(event: IncomingData, data: MessageDataT): void {

//    const any_msg = new Any();
//    any_msg.pack(data.serializeBinary(), typeUrlFromMessageClass(data) as string);

//    const message = new Event();
//    message.setEvent(EventType.RESPONSE);
//    message.setTag(event.msg.getTag());
//    message.setMessage(any_msg);

//    event.stream.write(message);
// }

class Architect implements ArchitectServiceImplementation {
   public service: ArchitectServiceImplementation;

   private _store: RootStore;

   private shutdown_subject: Subject<void> = new Subject<void>();
   private _stop_controller: AbortController;

   private _mutex = new Mutex();

   constructor(store?: RootStore) {
      // Use the default store if not supplied
      if (!store) {
         store = getRootStore();
      }

      this._store = store;

      this._stop_controller = new AbortController();

      // Have to do this. Look at
      // https://github.com/paymog/grpc_tools_node_protoc_ts/blob/master/doc/server_impl_signature.md to see about
      // getting around this restriction
      this.service = {
         eventStream: (request, context) => {
            return this.do_eventStream(request, context);
         },
         eventStreamUniDirect: (request, context) => {
            return this.do_eventStream_uni_direct(request, context);
         },
         ping: async (request, context): Promise<DeepPartial<PingResponse>> => {
            return await this.do_ping(request, context);
         },
         shutdown: async (request, context): Promise<DeepPartial<ShutdownResponse>> => {
            return await this.do_shutdown(request, context);
         },
      };
   }

   public async stop() {
      this._store.dispatch(stopAction());

      // Sleep here to allow any pending timeouts to be processed before continuing
      await sleep(0);

      // Trigger a stop cancellation for any connected streams
      this._stop_controller.abort("Stop signaled");
   }

   public eventStreamUniDirect(
      request: Event,
      context: CallContext
   ): ServerStreamingMethodResult<{
      event?: EventType | undefined;
      tag?: string | undefined;
      message?: { value?: Uint8Array | undefined; typeUrl?: string | undefined } | undefined;
      error?: { message?: string | undefined; code?: ErrorCode | undefined } | undefined;
   }> {
      return this.do_eventStream_uni_direct(request, context);
   }

   public eventStream(
      request: AsyncIterable<Event>,
      context: CallContext
   ): ServerStreamingMethodResult<{
      event?: EventType | undefined;
      tag?: string | undefined;
      message?: { value?: Uint8Array | undefined; typeUrl?: string | undefined } | undefined;
      error?: { message?: string | undefined; code?: ErrorCode | undefined } | undefined;
   }> {
      return this.do_eventStream(request, context);
   }
   public ping(request: PingRequest, context: CallContext): Promise<{ tag?: string | undefined }> {
      return this.do_ping(request, context);
   }
   public shutdown(request: ShutdownRequest, context: CallContext): Promise<{ tag?: string | undefined }> {
      return this.do_shutdown(request, context);
   }

   public onShutdownSignaled() {
      return firstValueFrom(this.shutdown_subject);
   }

   private async *do_eventStream_uni_direct(request: Event, context: CallContext): AsyncIterable<DeepPartial<Event>> {
      console.log(`Unidirectional Event stream created for ${context.peer}`);

      const executor: IExecutor = Executor.create(context.peer).get_interface();
      context.metadata.set("mrc-machine-id", executor.id.toString());

      const store_update_sink = new AsyncSink<Event>();

      // Subscribe to the store's next update
      const store_unsub = this._store.subscribe(() => {
         const state = this._store.getState();

         // Remove the system object from the state
         const { system: _, ...out_state } = {
            ...state,
            nonce: state.system.requestRunningNonce.toString(),
            system: { extra: true },
         };

         if (state.system.requestRunning) {
            console.log("Request is still running!");
         }

         // Push out the state update
         store_update_sink.write(
            packEvent(
               EventType.ServerStateUpdate,
               state.system.requestRunningNonce.toString(),
               ControlPlaneState.create(out_state as ControlPlaneState)
            )
         );
      });

      // Create a new connection
      this._store.dispatch(connectionsAdd(executor));

      // Yield a connected event
      yield Event.create({
         event: EventType.ClientEventStreamConnected,
         message: pack(
            ClientConnectedResponse.create({
               machineId: executor.id,
            })
         ),
      });

      try {
         // Only handle outgoing events, no incoming stream processing
         for await (const out_event of store_update_sink) {
            console.log(
               `Unidirectional stream: Sending event to ${executor.peerInfo}. EventID: ${eventTypeToJSON(out_event.event)}, Tag: ${
                  out_event.tag
               }`
            );
            yield out_event;
         }
      } catch (err) {
         const error = ensureError(err);
         console.log(`Error occurred in stream. Error: ${error.message}`);
      } finally {
         console.log(`All streams closed for ${executor.peerInfo}. Deleting connection: ${executor.id}.`);

         // Ensure the other streams are cleaned up
         store_unsub();
         store_update_sink.end();

         // Use the Lost Connection action to force all child objects to be removed too
         await this._store.dispatch(connectionsDropOne(executor));
      }
   }


   private async *do_eventStream(
      stream: AsyncIterable<Event>,
      context: CallContext
   ): AsyncIterable<DeepPartial<Event>> {
      console.log(`Event stream created for ${context.peer}`);

      const executor: IExecutor = Executor.create(context.peer).get_interface();

      context.metadata.set("mrc-machine-id", executor.id.toString());

      const store_update_sink = new AsyncSink<Event>();

      // Subscribe to the stores next update
      const store_unsub = this._store.subscribe(() => {
         const state = this._store.getState();

         // Remove the system object from the state
         const { system: _, ...out_state } = {
            ...state,
            nonce: state.system.requestRunningNonce.toString(),
            system: { extra: true },
         };

         if (state.system.requestRunning) {
            console.log("Request is still running!");
         }

         // Push out the state update
         store_update_sink.write(
            packEvent(
               EventType.ServerStateUpdate,
               state.system.requestRunningNonce.toString(),
               ControlPlaneState.create(out_state as ControlPlaneState)
            )
         );
      });

      // Create a new connection
      this._store.dispatch(connectionsAdd(executor));

      // eslint-disable-next-line @typescript-eslint/no-this-alias
      const self = this;

      // Yield a connected even
      yield Event.create({
         event: EventType.ClientEventStreamConnected,
         message: pack(
            ClientConnectedResponse.create({
               machineId: executor.id,
            })
         ),
      });

      const event_stream = async function* () {
         try {
            for await (const req of stream) {
               const request_identifier = `Peer:${executor.peerInfo},Event:${eventTypeToJSON(req.event)},Tag:${
                  req.tag
               }`;

               const yeilded_events: Event[] = [];

               // Ensure only one request is running at the same time. Otherwise the async order can get messed up
               const release = await self._mutex.acquire();

               try {
                  console.log(`--- Start Request for '${request_identifier}' ---`);

                  self._store.dispatch(systemStartRequest(request_identifier));

                  // Cache any yielded events to send after systemStopRequest
                  for await (const event of self.do_handle_event(
                     {
                        msg: req,
                        machineId: executor.id,
                     },
                     context
                  )) {
                     yeilded_events.push(event);
                  }
                  // yield* self.do_handle_event(
                  //    {
                  //       msg: req,
                  //       machineId: connection.id,
                  //    },
                  //    context
                  // );
               } finally {
                  // sleep for 0 to ensure all scheduled async tasks have been run before ending the request (very
                  // important for listeners)
                  await yield_immediate("event_stream");

                  self._store.dispatch(systemStopRequest(request_identifier));

                  // Now yield any generated events, after systemStopRequest
                  for (const event of yeilded_events) {
                     yield event;
                  }

                  console.log(`--- End Request for '${request_identifier}' ---`);

                  // Release the mutex
                  release();
               }
            }
         } catch (err) {
            const error = ensureError(err);
            console.log(`Error occurred in stream. Error: ${error.message}`);
         } finally {
            console.log(`Event stream closed for ${executor.peerInfo}.`);

            // Input stream has completed so stop pushing events
            store_unsub();

            store_update_sink.end();
         }
      };

      try {
         // Make the combined async iterable
         const combined_iterable = merge(
            as<Event>(event_stream()).pipe(withAbort(this._stop_controller.signal)),
            as<Event>(store_update_sink)
         );

         for await (const out_event of combined_iterable) {
            console.log(
               `Sending event to ${executor.peerInfo}. EventID: ${eventTypeToJSON(out_event.event)}, Tag: ${
                  out_event.tag
               }`
            );
            yield out_event;
         }
      } catch (err) {
         const error = ensureError(err);
         console.log(`Error occurred in stream. Error: ${error.message}`);
      } finally {
         console.log(`All streams closed for ${executor.peerInfo}. Deleting connection: ${executor.id}.`);

         // Ensure the other streams are cleaned up
         store_unsub();

         store_update_sink.end();

         // Use the Lost Connection action to force all child objects to be removed too
         await this._store.dispatch(connectionsDropOne(executor));
      }
   }

   private async *do_handle_event(event: IncomingData, context: CallContext) {
      try {
         switch (event.msg.event) {
            case EventType.ClientEventPing: {
               const payload = unpackEvent<PingRequest>(event.msg);

               console.log(`Ping from ${context.peer}. Tag: ${payload.tag}.`);

               yield unaryResponse(
                  event,
                  PingResponse.create({
                     tag: payload.tag,
                  })
               );

               break;
            }
            case EventType.ClientEventRequestStateUpdate:
               yield unaryResponse(event, StateUpdate.create({}));

               break;
            case EventType.ClientUnaryRegisterWorkers: {
               const payload = unpackEvent<RegisterWorkersRequest>(event.msg);

               const workers: IWorker[] = payload.ucxWorkerAddresses.map((value): IWorker => {
                  return {
                     id: generateId(),
                     executorId: event.machineId,
                     partitionAddress: 0,
                     ucxAddress: value,
                     state: {
                        requestedStatus: ResourceRequestedStatus.Requested_Initialized,
                        actualStatus: ResourceActualStatus.Actual_Unknown,
                        dependees: [],
                        dependers: [],
                     },
                     assignedSegmentIds: [],
                  };
               });

               // Add the workers
               this._store.dispatch(workersAddMany(workers));

               const resp = RegisterWorkersResponse.create({
                  machineId: event.machineId,
                  instanceIds: workersSelectByMachineId(this._store.getState(), event.machineId).map(
                     (worker) => worker.id
                  ),
               });

               yield unaryResponse(event, resp);

               break;
            }
            case EventType.ClientUnaryDropWorker: {
               const payload = unpackEvent<TaggedInstance>(event.msg);

               const found_worker = workersSelectById(this._store.getState(), payload.instanceId);

               if (found_worker) {
                  this._store.dispatch(workersRemove(found_worker)); // TODO: removing a worker should cascade to segments
               }

               yield unaryResponse(event, Ack.create());

               break;
            }
            case EventType.ClientUnaryPipelineRegisterConfig: {
               const payload = unpackEvent<PipelineRegisterConfigRequest>(event.msg);

               // Check to make sure its not null
               if (!payload.config) {
                  throw new Error("`pipeline` cannot be undefined");
               }

               // Issue the create or update action
               const definition = this._store.dispatch(pipelineDefinitionsCreateOrUpdate(payload.config));

               // if (!payload.mapping) {
               //    throw new Error("`mapping` cannot be undefined");
               // }

               // if (payload.mapping.machineId == "0") {
               //    payload.mapping.machineId = event.machineId;
               // } else if (payload.mapping.machineId != event.machineId) {
               //    throw new Error("Incorrect machineId");
               // }

               // // Add a pipeline assignment to the machine
               // const addedInstances = this._store.dispatch(
               //    pipelineInstancesAssign({
               //       pipeline: payload.pipeline,
               //       mapping: payload.mapping,
               //    })
               // );

               yield unaryResponse(
                  event,
                  PipelineRegisterConfigResponse.create({
                     pipelineDefinitionId: definition.id,
                  })
               );

               break;
            }
            case EventType.ClientUnaryPipelineAddMapping: {
               const payload = unpackEvent<PipelineAddMappingRequest>(event.msg);

               // Check to make sure its not null
               if (!payload.mapping) {
                  throw new Error("`mapping` cannot be undefined");
               }

               if (payload.mapping.executorId == "0") {
                  payload.mapping.executorId = event.machineId;
               } else if (payload.mapping.executorId != event.machineId) {
                  throw new Error("Incorrect machineId");
               }

               // Issue the create or update action
               this._store.dispatch(
                  pipelineDefinitionsSetMapping({
                     definition_id: payload.definitionId,
                     mapping: payload.mapping,
                  })
               );

               const connection = connectionsSelectById(this._store.getState(), payload.mapping.executorId);

               if (!connection) {
                  throw new Error(`Could not find connection with ID: ${payload.mapping.executorId}`);
               }

               const pipeline = PipelineInstance.create(connection, payload.definitionId);

               // Create a pipeline instance with this mapping (Should be moved elsewhere eventually)
               this._store.dispatch(pipelineInstancesAdd(pipeline.get_interface()));

               // // Add a pipeline assignment to the machine
               // const addedInstances = this._store.dispatch(
               //    pipelineInstancesAssign({
               //       pipeline: payload.pipeline,
               //       mapping: payload.mapping,
               //    })
               // );

               yield unaryResponse(
                  event,
                  PipelineAddMappingResponse.create({
                     pipelineInstanceId: pipeline.id,
                  })
               );

               break;
            }
            case EventType.ClientUnaryManifoldUpdateActualAssignments: {
               const payload = unpackEvent<ManifoldUpdateActualAssignmentsRequest>(event.msg);

               this._store.dispatch(
                  manifoldInstancesUpdateActualSegments(
                     payload.manifoldInstanceId,
                     payload.actualInputSegments,
                     payload.actualOutputSegments
                  )
               );

               yield unaryResponse(
                  event,
                  ManifoldUpdateActualAssignmentsResponse.create({
                     ok: true,
                  })
               );

               break;
            }
            case EventType.ClientUnaryResourceUpdateStatus: {
               const payload = unpackEvent<ResourceUpdateStatusRequest>(event.msg);

               // Check to make sure its not null
               switch (payload.resourceType) {
                  case "Connections": {
                     const found = connectionsSelectById(this._store.getState(), payload.resourceId);

                     if (!found) {
                        throw new Error(`Could not find Workers for ID: ${payload.resourceId}`);
                     }

                     this._store.dispatch(
                        connectionsUpdateResourceActualState({
                           resource: found,
                           status: payload.status,
                        })
                     );

                     break;
                  }
                  case "Workers": {
                     const found = workersSelectById(this._store.getState(), payload.resourceId);

                     if (!found) {
                        throw new Error(`Could not find Workers for ID: ${payload.resourceId}`);
                     }

                     this._store.dispatch(
                        workersUpdateResourceActualState({
                           resource: found,
                           status: payload.status,
                        })
                     );

                     break;
                  }
                  case "PipelineInstances": {
                     const found = pipelineInstancesSelectById(this._store.getState(), payload.resourceId);

                     if (!found) {
                        throw new Error(`Could not find PipelineInstance for ID: ${payload.resourceId}`);
                     }

                     this._store.dispatch(
                        pipelineInstancesUpdateResourceActualState({
                           resource: found,
                           status: payload.status,
                        })
                     );

                     break;
                  }
                  case "SegmentInstances": {
                     const found = segmentInstancesSelectById(this._store.getState(), payload.resourceId);

                     if (!found) {
                        throw new Error(`Could not find SegmentInstance for ID: ${payload.resourceId}`);
                     }

                     this._store.dispatch(
                        segmentInstancesUpdateResourceActualState({
                           resource: found,
                           status: payload.status,
                        })
                     );

                     break;
                  }
                  case "ManifoldInstances": {
                     const found = manifoldInstancesSelectById(this._store.getState(), payload.resourceId);

                     if (!found) {
                        throw new Error(`Could not find ManifoldInstance for ID: ${payload.resourceId}`);
                     }

                     this._store.dispatch(
                        manifoldInstancesUpdateResourceActualState({
                           resource: found,
                           status: payload.status,
                        })
                     );

                     break;
                  }
                  default:
                     throw new Error(`Unsupported resource type: ${payload.resourceType}`);
               }

               yield unaryResponse(event, ResourceUpdateStatusResponse.create({ ok: true }));

               break;
            }
            case EventType.ClientUnaryResourceStopRequest: {
               const payload = unpackEvent<ResourceUpdateStatusRequest>(event.msg);

               switch (payload.resourceType) {
                  case "SegmentInstances": {
                     this._store.dispatch(segmentInstancesRequestStop(payload.resourceId));

                     break;
                  }
                  default:
                     throw new Error(`Unsupported resource type: ${payload.resourceType}`);
               }
               yield unaryResponse(event, ResourceStopResponse.create({ ok: true }));

               break;
            }
            default:
               break;
         }
      } catch (err) {
         const error = ensureError(err);

         console.error(`Error occurred handing event. Error: ${error.message}`);

         // // Now yield an error message to pass back to the client
         // yield Event.create({
         //    error: {
         //       message: error.message,
         //    },
         //    event: EventType.Response,
         //    tag: event.msg.tag,
         // });
      }
   }

   private async do_shutdown(req: ShutdownRequest, context: CallContext): Promise<DeepPartial<ShutdownResponse>> {
      console.log(`Issuing shutdown promise from ${context.peer}`);

      // Signal that shutdown was requested
      this.shutdown_subject.next();

      return ShutdownResponse.create();
   }

   private async do_ping(req: PingRequest, context: CallContext): Promise<DeepPartial<PingResponse>> {
      console.log(`Ping from ${context.peer}`);

      return PingResponse.create({
         tag: req.tag,
      });
   }
}

// class Architect implements ArchitectServer{
//    [name: string]: UntypedHandleCall;
//    eventStream: handleBidiStreamingCall<Event, Event>;
//    shutdown: handleUnaryCall<ShutdownRequest, ShutdownResponse>;

// }

// class Architect implements ArchitectServer {
//    [name: string]: UntypedHandleCall;

//    constructor() {
//       console.log("Created");

//       this.a = 5;
//    }

//    public eventStream(call: ServerDuplexStream<Event, Event>): void {
//       console.log(`Event stream created for ${call.getPeer()}`);

//       call.on("data", (req: Event) => {
//          console.log(`Event stream data for ${call.getPeer()} with message: ${req.event.toString()}`);
//          // this.do_handle_event(req, call);
//       });

//       call.on("error", (err: Error) => {
//          console.log(`Event stream errored for ${call.getPeer()} with message: ${err.message}`);
//       });

//       call.on("end", () => {
//          console.log(`Event stream closed for ${call.getPeer()}`);
//       });
//    }

//    private do_handle_event(event: Event, call: ServerDuplexStream<Event, Event>): void{

//       try {
//          switch (event.event) {
//             case EventType.ClientEventRequestStateUpdate:

//                break;

//             default:
//                break;
//          }
//       } catch (error) {

//       }

//    }

// }

export { Architect };
