/* eslint-disable @typescript-eslint/unbound-method */
import { createSelector, createSlice, PayloadAction } from "@reduxjs/toolkit";

import { connectionsRemove } from "@mrc/server/store/slices/connectionsSlice";
import { pipelineInstancesRemove, pipelineInstancesSelectById } from "@mrc/server/store/slices/pipelineInstancesSlice";
import { workersRemove } from "@mrc/server/store/slices/workersSlice";
import { IManifoldInstance, IResourceDefinition, ISegmentInstance } from "@mrc/common/entities";
import {
   ResourceActualStatus,
   resourceActualStatusToNumber,
   resourceRequestedStatusToNumber,
   ResourceType,
} from "@mrc/proto/mrc/protos/architect_state";
import { pipelineDefinitionsSelectById } from "@mrc/server/store/slices/pipelineDefinitionsSlice";
import { AppListenerAPI } from "@mrc/server/store/listener_middleware";
import { yield_immediate } from "@mrc/common/utils";
import { ResourceRequestedStatus } from "@mrc/proto/mrc/protos/architect_state";
import {
   manifoldInstancesAdd,
   manifoldInstancesDetachRequestedSegment,
   manifoldInstancesSelectById,
   manifoldInstancesSelectByNameAndPipelineDef,
   manifoldInstancesSelectByPipelineId,
   manifoldInstancesSyncSegments,
} from "@mrc/server/store/slices/manifoldInstancesSlice";
import { createWatcher } from "@mrc/server/store/resourceStateWatcher";
import { AppDispatch, AppGetState, RootState } from "@mrc/server/store/store";
import { createWrappedEntityAdapter } from "@mrc/server/utils";
import { ManifoldInstance } from "@mrc/common/models/manifold_instance";
import { addDependee, removeDependee } from "@mrc/common/models/resource_state";

const segmentInstancesAdapter = createWrappedEntityAdapter<ISegmentInstance>({
   selectId: (w) => w.id,
});

export const segmentInstancesSlice = createSlice({
   name: "segmentInstances",
   initialState: segmentInstancesAdapter.getInitialState(),
   reducers: {
      add: (state, action: PayloadAction<ISegmentInstance>) => {
         if (segmentInstancesAdapter.getOne(state, action.payload.id)) {
            throw new Error(`Segment Instance with ID: ${action.payload.id} already exists`);
         }
         segmentInstancesAdapter.addOne(state, action.payload);
      },
      remove: (state, action: PayloadAction<ISegmentInstance>) => {
         const found = segmentInstancesAdapter.getOne(state, action.payload.id);

         if (!found) {
            throw new Error(`Segment Instance with ID: ${action.payload.id} not found`);
         }

         if (found.state?.actualStatus != ResourceActualStatus.Actual_Destroyed) {
            throw new Error(
               `Attempting to delete Segment Instance with ID: ${action.payload.id} while it has not finished. Stop SegmentInstance first!`
            );
         }

         segmentInstancesAdapter.removeOne(state, action.payload.id);
      },
      updateResourceRequestedState: (
         state,
         action: PayloadAction<{ resource: ISegmentInstance; status: ResourceRequestedStatus }>
      ) => {
         const found = segmentInstancesAdapter.getOne(state, action.payload.resource.id);

         if (!found) {
            throw new Error(`Segment Instance with ID: ${action.payload.resource.id} not found`);
         }

         if (
            resourceRequestedStatusToNumber(found.state.requestedStatus) >
            resourceRequestedStatusToNumber(action.payload.status)
         ) {
            throw new Error(
               `Cannot update state of Instance with ID: ${action.payload.resource.id}. Current state ${found.state.requestedStatus} is greater than requested state ${action.payload.status}`
            );
         }

         found.state.requestedStatus = action.payload.status;
      },
      updateResourceActualState: (
         state,
         action: PayloadAction<{ resource: ISegmentInstance; status: ResourceActualStatus }>
      ) => {
         const found = segmentInstancesAdapter.getOne(state, action.payload.resource.id);

         if (!found) {
            throw new Error(`Segment Instance with ID: ${action.payload.resource.id} not found`);
         }

         if (
            resourceActualStatusToNumber(found.state.actualStatus) > resourceActualStatusToNumber(action.payload.status)
         ) {
            throw new Error(
               `Cannot update state of Instance with ID: ${action.payload.resource.id}. Current state ${found.state.actualStatus} is greater than requested state ${action.payload.status}`
            );
         }

         found.state.actualStatus = action.payload.status;
      },

      incRefCount: (state, action: PayloadAction<{ segment: ISegmentInstance; resource: IResourceDefinition }>) => {
         // TODO: refCount should be renamed to "dependees" and should be a list in the form of
         // [{"type": "ManifoldInstance", "id": "id"} ...]
         const found = segmentInstancesAdapter.getOne(state, action.payload.segment.id);
         if (!found) {
            throw new Error(`Segment Instance with ID: ${action.payload.segment.id} not found`);
         }
         addDependee(action.payload.resource, found.state);
      },

      decRefCount: (state, action: PayloadAction<{ segment: ISegmentInstance; resource: IResourceDefinition }>) => {
         const found = segmentInstancesAdapter.getOne(state, action.payload.segment.id);
         if (!found) {
            throw new Error(`Segment Instance with ID: ${action.payload.segment.id} not found`);
         } else if (found.state.dependees.length == 0) {
            throw new Error(`Segment Instance with ID: ${action.payload.segment.id} has refCount 0`);
         }

         removeDependee(action.payload.resource, found.state);

         if (found.state.dependees.length == 0) {
            // Segment has no dependees OK to stop now
            // TODO: We need some way to distinguish between a segment which simply has no more depenees and should run
            // to completion (ex. `Requested_Completed`), and a segment which already requested to stop.
            // This handles the second situation.
            found.state.requestedStatus = ResourceRequestedStatus.Requested_Stopped;
         }
      },
   },
   extraReducers: (builder) => {
      builder.addCase(connectionsRemove, (state, action) => {
         // Need to delete any segments associated with the worker
         const instances = selectByWorkerId(state, action.payload.id);

         segmentInstancesAdapter.removeMany(
            state,
            instances.map((x) => x.id)
         );
      });
      builder.addCase(workersRemove, (state, action) => {
         // Need to delete any segments associated with the worker
         const instances = selectByWorkerId(state, action.payload.id);

         segmentInstancesAdapter.removeMany(
            state,
            instances.map((x) => x.id)
         );
      });
      builder.addCase(pipelineInstancesRemove, (state, action) => {
         // Need to delete any segments associated with the pipeline
         const instances = selectByPipelineId(state, action.payload.id);

         segmentInstancesAdapter.removeMany(
            state,
            instances.map((x) => x.id)
         );
      });
   },
});

export function segmentInstancesAddMany(instances: ISegmentInstance[]) {
   // To allow the watchers to work, we need to add all segments individually
   return (dispatch: AppDispatch) => {
      // Loop and dispatch each segment individually
      instances.forEach((s) => {
         dispatch(segmentInstancesAdd(s));
      });
   };
}

export function segmentInstancesRequestStop(segmentInstanceId: string) {
   return (dispatch: AppDispatch, getState: AppGetState) => {
      // In the future we will have more than just manifolds that depend on segments, see comment in `incRefCount`
      const state = getState();
      const found = segmentInstancesSelectById(state, segmentInstanceId);
      if (!found) {
         throw new Error(`Segment Instance with ID: ${segmentInstanceId} not found`);
      }

      dispatch(
         segmentInstancesSlice.actions.updateResourceActualState({
            resource: found,
            status: ResourceActualStatus.Actual_Stopping,
         })
      );

      if (found.state.dependees.length == 0) {
         // Segment has no dependees OK to stop now
         dispatch(
            segmentInstancesSlice.actions.updateResourceRequestedState({
               resource: found,
               status: ResourceRequestedStatus.Requested_Stopped,
            })
         );
      } else {
         found.state.dependees.forEach((resource) => {
            if (resource.resourceType === ResourceType.Manifold_Instance) {
               const manifold = manifoldInstancesSelectById(state, resource.resourceId);
               if (manifold) {
                  if (found.segmentAddress in (manifold?.requestedInputSegments ?? {})) {
                     dispatch(manifoldInstancesDetachRequestedSegment({ manifold, is_input: true, segment: found }));
                  } else if (found.segmentAddress in (manifold?.requestedOutputSegments ?? {})) {
                     dispatch(manifoldInstancesDetachRequestedSegment({ manifold, is_input: false, segment: found }));
                  }
               }
            }
         });
      }
   };
}

export function segmentInstancesDestroy(instance: ISegmentInstance) {
   // To allow the watchers to work, we need to add all segments individually
   return async (dispatch: AppDispatch, getState: AppGetState) => {
      // For any found workers, set the requested and actual states to avoid errors
      const found = segmentInstancesSelectById(getState(), instance.id);

      if (found) {
         // Set the requested to destroyed
         dispatch(
            segmentInstancesUpdateResourceRequestedState({
               resource: instance,
               status: ResourceRequestedStatus.Requested_Destroyed,
            })
         );

         // Yield here to allow listeners to run
         await yield_immediate();

         // Set the actual to destroyed
         dispatch(
            segmentInstancesUpdateResourceActualState({
               resource: instance,
               status: ResourceActualStatus.Actual_Destroyed,
            })
         );

         // Yield here to allow listeners to run
         await yield_immediate();

         // Finally, run the remove segment action just to be sure
         if (segmentInstancesSelectById(getState(), instance.id)) {
            console.warn("SegmentInstances watcher did not correctly destroy instance. Manually destroying.");
            dispatch(segmentInstancesRemove(instance));
         }
      }
   };
}

type SegmentInstancesStateType = ReturnType<typeof segmentInstancesSlice.getInitialState>;

export const {
   add: segmentInstancesAdd,
   incRefCount: segmentInstanceIncRefCount,
   decRefCount: segmentInstanceDecRefCount,
   // addMany: segmentInstancesAddMany,
   // requestStop: segmentInstancesRequestStop,
   remove: segmentInstancesRemove,
   updateResourceRequestedState: segmentInstancesUpdateResourceRequestedState,
   updateResourceActualState: segmentInstancesUpdateResourceActualState,
} = segmentInstancesSlice.actions;

export const {
   selectAll: segmentInstancesSelectAll,
   selectById: segmentInstancesSelectById,
   selectByIds: segmentInstancesSelectByIds,
   selectEntities: segmentInstancesSelectEntities,
   selectIds: segmentInstancesSelectIds,
   selectTotal: segmentInstancesSelectTotal,
} = segmentInstancesAdapter.getSelectors((state: RootState) => state.segmentInstances);

const selectByWorkerId = createSelector(
   [segmentInstancesAdapter.getAll, (state: SegmentInstancesStateType, executorId: string) => executorId],
   (segmentInstances, executorId) => segmentInstances.filter((x) => x.executorId === executorId)
);

export const segmentInstancesSelectByWorkerId = (state: RootState, worker_id: string) =>
   selectByWorkerId(state.segmentInstances, worker_id);

const selectByPipelineId = createSelector(
   [segmentInstancesAdapter.getAll, (state: SegmentInstancesStateType, pipeline_id: string) => pipeline_id],
   (segmentInstances, pipeline_id) => segmentInstances.filter((x) => x.pipelineInstanceId === pipeline_id)
);

export const segmentInstancesSelectByPipelineId = (state: RootState, pipeline_id: string) =>
   selectByPipelineId(state.segmentInstances, pipeline_id);

const selectByAddress = createSelector(
   [segmentInstancesAdapter.getAll, (state: SegmentInstancesStateType, segmentAddress: string) => segmentAddress],
   (segmentInstances, segmentAddress) => segmentInstances.find((x) => x.segmentAddress === segmentAddress)
);

export const segmentInstancesSelectByAddress = (state: RootState, segmentAddress: string) =>
   selectByAddress(state.segmentInstances, segmentAddress);

const selectByNameAndPipelineDef = createSelector(
   [
      segmentInstancesAdapter.getAll,
      (state: SegmentInstancesStateType, segmentName: string) => segmentName,
      (state: SegmentInstancesStateType, segmentName: string, pipelineDefinitionId: string) => pipelineDefinitionId,
   ],
   (segmentInstances, segmentName, pipelineDefinitionId) =>
      segmentInstances.filter((x) => x.name === segmentName && x.pipelineDefinitionId === pipelineDefinitionId)
);

export const segmentInstancesSelectByNameAndPipelineDef = (
   state: RootState,
   segmentName: string,
   pipelineDefinitionId: string
) => selectByNameAndPipelineDef(state.segmentInstances, segmentName, pipelineDefinitionId);

export function syncManifolds(listenerApi: AppListenerAPI, instance: ISegmentInstance) {
   const state = listenerApi.getState();

   const pipeline_def = pipelineDefinitionsSelectById(state, instance.pipelineDefinitionId);

   if (!pipeline_def) {
      throw new Error(
         `Could not find Pipeline Definition ID: ${instance.pipelineDefinitionId}, for Segment Instance: ${instance.id}`
      );
   }

   const pipeline_instance = pipelineInstancesSelectById(state, instance.pipelineInstanceId);

   if (!pipeline_instance) {
      throw new Error(
         `Could not find Pipeline Instance ID: ${instance.pipelineInstanceId}, for Segment Instance: ${instance.id}`
      );
   }

   // Find our definition
   if (!(instance.name in pipeline_def.segments)) {
      throw new Error(
         `Could not find Segment: ${instance.name} in for Pipeline Definition: ${instance.pipelineDefinitionId}`
      );
   }

   const seg_def = pipeline_def.segments[instance.name];

   // Loop over the ingress ports and egress ports to get all names
   // const manifold_names = new Set<string>(Object.entries(seg_def.egressPorts).map(([port_name]) => port_name));
   // Object.entries(seg_def.ingressPorts).forEach(([port_name]) => manifold_names.add(port_name));

   const manifold_names = [
      ...new Set(Object.keys(seg_def.egressManifoldIds).concat(Object.keys(seg_def.ingressManifoldIds))),
   ];

   const running_manifolds = manifoldInstancesSelectByPipelineId(state, instance.pipelineInstanceId);

   const manifolds: IManifoldInstance[] = manifold_names.map((port_name) => {
      const manifold_idx = running_manifolds.findIndex((value) => value.portName === port_name);

      // See if the manifold already exists
      if (manifold_idx === -1) {
         // Dispatch a new manifold
         return listenerApi.dispatch(manifoldInstancesAdd(ManifoldInstance.create(pipeline_instance, port_name)))
            .payload;
      } else {
         return running_manifolds[manifold_idx];
      }
   });

   // Sync all possibly connected manifolds
   manifold_names.forEach((manifoldName) => {
      const allManifolds = manifoldInstancesSelectByNameAndPipelineDef(state, manifoldName, pipeline_def.id);

      // Now attach the segment to its local manifolds
      allManifolds.forEach((m) => {
         listenerApi.dispatch(manifoldInstancesSyncSegments(m.id));
      });
   });

   return manifolds;
}

// export function segmentInstancesConfigureListeners() {
//    startAppListening({
//       actionCreator: segmentInstancesAdd,
//       effect: async (action, listenerApi) => {
//          const segment_id = action.payload.id;

//          const instance = segmentInstancesSelectById(listenerApi.getState(), segment_id);

//          if (!instance) {
//             throw new Error("Could not find segment instance");
//          }

//          // Now that the object has been created, set the requested status to Created
//          listenerApi.dispatch(
//             segmentInstancesSlice.actions.updateResourceRequestedState({
//                resource: instance,
//                status: ResourceRequestedStatus.Requested_Created,
//             })
//          );

//          const monitor_instance = listenerApi.fork(async () => {
//             while (true) {
//                // Wait for the next update
//                const [, current_state] = await listenerApi.take((action) => {
//                   return (
//                      segmentInstancesUpdateResourceActualState.match(action) &&
//                      action.payload.resource.id === segment_id
//                   );
//                });

//                if (!current_state.system.requestRunning) {
//                   console.warn("Updating resource outside of a request will lead to undefined behavior!");
//                }

//                // Get the status of this instance
//                const instance = segmentInstancesSelectById(listenerApi.getState(), segment_id);

//                if (!instance) {
//                   throw new Error("Could not find instance");
//                }

//                if (instance.state.actualStatus === ResourceActualStatus.Actual_Created) {
//                   // Before moving to RunUntilComplete, perform a few actions

//                   // Increment the ref count on our pipeline instance

//                   // Create any missing manifolds
//                   const manifolds = syncManifolds(listenerApi, instance);

//                   // Increment the ref count on our manifolds

//                   // Tell it to move running/completed
//                   listenerApi.dispatch(
//                      segmentInstancesSlice.actions.updateResourceRequestedState({
//                         resource: instance,
//                         status: ResourceRequestedStatus.Requested_Completed,
//                      })
//                   );
//                } else if (instance.state.actualStatus === ResourceActualStatus.Actual_Completed) {
//                   // Before we can move to Stopped, all ref counts must be 0

//                   // Tell it to move to stopped
//                   listenerApi.dispatch(
//                      segmentInstancesSlice.actions.updateResourceRequestedState({
//                         resource: instance,
//                         status: ResourceRequestedStatus.Requested_Stopped,
//                      })
//                   );
//                } else if (instance.state.actualStatus === ResourceActualStatus.Actual_Stopped) {
//                   // Tell it to move to stopped
//                   listenerApi.dispatch(
//                      segmentInstancesSlice.actions.updateResourceRequestedState({
//                         resource: instance,
//                         status: ResourceRequestedStatus.Requested_Destroyed,
//                      })
//                   );
//                } else if (instance.state.actualStatus === ResourceActualStatus.Actual_Destroyed) {
//                   // Now we can actually just remove the object
//                   listenerApi.dispatch(segmentInstancesRemove(instance));

//                   break;
//                } else {
//                   throw new Error("Unknow state type");
//                }
//             }
//          });

//          await listenerApi.condition((action) => {
//             return segmentInstancesRemove.match(action) && action.payload.id === segment_id;
//          });
//          monitor_instance.cancel();
//       },
//    });
// }

export function segmentInstancesConfigureSlice() {
   createWatcher(
      "SegmentInstances", // resourceTypeString
      segmentInstancesAdd, //  actionCreator
      segmentInstancesSelectById, // getResourceInstance
      async (instance, listenerApi) => {
         // onCreated
         // Create any missing manifolds
         const manifolds = syncManifolds(listenerApi, instance);

         // Increment the ref count on our manifolds
      },
      async (instance) => {}, // onRunning
      async (instance) => {}, // onCompleted
      async (instance, listenerApi) => {
         // onStopped
         const manifolds = syncManifolds(listenerApi, instance);
      },
      async (instance, listenerApi) => {
         // onDestroyed
         listenerApi.dispatch(segmentInstancesRemove(instance));
      }
   );

   return segmentInstancesSlice.reducer;
}
