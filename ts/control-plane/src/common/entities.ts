import {
   Executor,
   EgressPort,
   IngressPort,
   ManifoldInstance,
   ManifoldOptions,
   PipelineConfiguration,
   PipelineConfiguration_ManifoldConfiguration,
   PipelineConfiguration_SegmentConfiguration,
   PipelineDefinition,
   PipelineDefinition_ManifoldDefinition,
   PipelineDefinition_SegmentDefinition,
   PipelineInstance,
   PipelineMapping,
   PipelineMapping_SegmentMapping,
   PortInfo,
   ResourceState,
   ScalingOptions,
   SegmentInstance,
   SegmentOptions,
   Worker,
   ResourceDefinition,
} from "@mrc/proto/mrc/protos/architect_state";

export type IResourceState = Omit<ResourceState, "$type">;
export type IResourceDefinition = Omit<ResourceDefinition, "$type">;

export interface IResourceInstance {
   id: string;
   state: IResourceState;
}

export type IExecutor = Omit<Executor, "$type" | "state"> & IResourceInstance;

export type IWorker = Omit<Worker, "$type" | "state"> & IResourceInstance;

export type IPortInfo = Omit<PortInfo, "$type">;
export type IIngressPort = Omit<IngressPort, "$type">;
export type IEgressPort = Omit<EgressPort, "$type">;
export type IScalingOptions = Omit<ScalingOptions, "$type">;
export type ISegmentOptions = Omit<SegmentOptions, "$type"> & {
   scalingOptions?: IScalingOptions;
};

export type ISegmentConfiguration = Omit<PipelineConfiguration_SegmentConfiguration, "$type" | "options"> & {
   options?: ISegmentOptions;
};

export type IManifoldOptions = Omit<ManifoldOptions, "$type">;

export type IManifoldConfiguration = Omit<PipelineConfiguration_ManifoldConfiguration, "$type" | "options"> & {
   options?: IManifoldOptions;
};

export type ISegmentMapping = Omit<PipelineMapping_SegmentMapping, "$type">;

export type IPipelineMapping = Omit<PipelineMapping, "$type" | "segments"> & {
   segments: { [key: string]: ISegmentMapping };
};

export type IPipelineConfiguration = Omit<PipelineConfiguration, "$type" | "segments" | "manifolds"> & {
   segments: { [key: string]: ISegmentConfiguration };
   manifolds: { [key: string]: IManifoldConfiguration };
};

export type ISegmentDefinition = Omit<PipelineDefinition_SegmentDefinition, "$type" | "options"> & {
   options?: ISegmentOptions;
};

export type IManifoldDefinition = Omit<PipelineDefinition_ManifoldDefinition, "$type" | "options"> & {
   options?: IManifoldOptions;
};

export type IPipelineDefinition = Omit<
   PipelineDefinition,
   "$type" | "config" | "mappings" | "segments" | "manifolds"
> & {
   config: IPipelineConfiguration;
   mappings: { [key: string]: IPipelineMapping };
   segments: { [key: string]: ISegmentDefinition };
   manifolds: { [key: string]: IManifoldDefinition };
};

export type IPipelineInstance = Omit<PipelineInstance, "$type" | "state"> & IResourceInstance;

export type ISegmentInstance = Omit<SegmentInstance, "$type" | "state"> & IResourceInstance;

export type IManifoldInstance = Omit<ManifoldInstance, "$type" | "state"> & IResourceInstance;

export type ResourceStateTypes = IExecutor | IWorker | IPipelineInstance | ISegmentInstance | IManifoldInstance;
export type ResourceStateTypeStrings =
   | "Connections"
   | "Workers"
   | "PipelineInstances"
   | "SegmentInstances"
   | "ManifoldInstances";
