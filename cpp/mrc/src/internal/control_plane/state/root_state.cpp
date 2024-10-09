#include "internal/control_plane/state/root_state.hpp"

#include "mrc/protos/architect_state.pb.h"
#include "mrc/types.hpp"

#include <google/protobuf/util/json_util.h>
#include <google/protobuf/util/message_differencer.h>

#include <cstdint>
#include <memory>
#include <utility>

namespace mrc::control_plane::state {

// auto __map_at_with_check(auto map_obj, auto id, const std::string& filename)
// {
//     return map_obj.at(id);
// }

// #define MAP_AT_WITH_CHECK(map_obj, id)                                                                  \
//     ({                                                                                                  \
//         DCHECK(map_obj.contains(id)) << "Inconsistent state! " << #map_obj << " is missing ID: " << id; \
//         const auto& __x = map_obj.at(id);                                                               \
//         __x;                                                                                            \
//     })

// template <typename T>
// const T& get_and_check(const std::map<uint64_t, T>)

#define MAP_AT_WITH_CHECK(map_obj, id) map_obj.at(id)

ControlPlaneStateBase::ControlPlaneStateBase(const google::protobuf::Message& message) : m_internal_message(message) {}

bool ControlPlaneStateBase::operator==(const ControlPlaneStateBase& other) const
{
    // // Make sure neither are null
    // if (m_internal_message == nullptr || other.m_internal_message == nullptr)
    // {
    //     return m_internal_message == other.m_internal_message;
    // }

    std::string left;
    std::string right;

    google::protobuf::util::MessageToJsonString(m_internal_message, &left);
    google::protobuf::util::MessageToJsonString(other.m_internal_message, &right);

    return google::protobuf::util::MessageDifferencer::Equals(m_internal_message, other.m_internal_message);
}

ControlPlaneNormalizedState::ControlPlaneNormalizedState(std::unique_ptr<protos::ControlPlaneState> message) :
  root_message(std::move(message))
{}

void ControlPlaneNormalizedState::initialize()
{
    this->nonce = root_message->nonce();

    // For each message type, create a wrapper
    for (const auto& id : root_message->executors().ids())
    {
        executors.emplace(id, Executor(this->shared_from_this(), root_message->executors().entities().at(id)));
    }

    for (const auto& id : root_message->workers().ids())
    {
        workers.emplace(id, Worker(this->shared_from_this(), root_message->workers().entities().at(id)));
    }

    for (const auto& id : root_message->pipeline_definitions().ids())
    {
        pipeline_definitions.emplace(
            id,
            PipelineDefinition(this->shared_from_this(), root_message->pipeline_definitions().entities().at(id)));
    }

    for (const auto& id : root_message->pipeline_instances().ids())
    {
        pipeline_instances.emplace(
            id,
            PipelineInstance(this->shared_from_this(), root_message->pipeline_instances().entities().at(id)));
    }

    for (const auto& id : root_message->manifold_instances().ids())
    {
        manifold_instances.emplace(
            id,
            ManifoldInstance(this->shared_from_this(), root_message->manifold_instances().entities().at(id)));
    }

    for (const auto& id : root_message->segment_instances().ids())
    {
        segment_instances.emplace(
            id,
            SegmentInstance(this->shared_from_this(), root_message->segment_instances().entities().at(id)));
    }
}

std::shared_ptr<ControlPlaneNormalizedState> ControlPlaneNormalizedState::create(
    std::unique_ptr<protos::ControlPlaneState> root_message)
{
    // Use new for the private constructor
    auto obj = std::shared_ptr<ControlPlaneNormalizedState>(new ControlPlaneNormalizedState(std::move(root_message)));

    // Must initialize as soon as object is created
    obj->initialize();

    return obj;
}

ControlPlaneState::ControlPlaneState(std::unique_ptr<protos::ControlPlaneState> message) :
  m_root_state(ControlPlaneNormalizedState::create(std::move(message)))
{}

const std::map<uint64_t, Executor>& ControlPlaneState::connections() const
{
    return m_root_state->executors;
}

const std::map<uint64_t, Worker>& ControlPlaneState::workers() const
{
    return m_root_state->workers;
}

const std::map<uint64_t, PipelineDefinition>& ControlPlaneState::pipeline_definitions() const
{
    return m_root_state->pipeline_definitions;
}

const std::map<uint64_t, PipelineInstance>& ControlPlaneState::pipeline_instances() const
{
    return m_root_state->pipeline_instances;
}

const std::map<uint64_t, ManifoldInstance>& ControlPlaneState::manifold_instances() const
{
    return m_root_state->manifold_instances;
}

const std::map<uint64_t, SegmentInstance>& ControlPlaneState::segment_instances() const
{
    return m_root_state->segment_instances;
}

ResourceState::ResourceState(const protos::ResourceState& message) : ControlPlaneStateBase(message), m_message(message)
{}

ResourceRequestedStatus ResourceState::requested_status() const
{
    return static_cast<ResourceRequestedStatus>(m_message.requested_status());
}

ResourceActualStatus ResourceState::actual_status() const
{
    return static_cast<ResourceActualStatus>(m_message.actual_status());
}

const std::vector<mrc::protos::ResourceDefinition>& ResourceState::dependees() const
{
    static std::vector<mrc::protos::ResourceDefinition> dependees_vector;
    dependees_vector.clear();
    for (const auto& dependee : m_message.dependees()) {
        dependees_vector.push_back(dependee);
    }
    return dependees_vector;
}

const std::vector<mrc::protos::ResourceDefinition>& ResourceState::dependers() const
{
    static std::vector<mrc::protos::ResourceDefinition> dependers_vector;
    dependers_vector.clear();
    for (const auto& dependee : m_message.dependers()) {
        dependers_vector.push_back(dependee);
    }
    return dependers_vector;
}

// Connection::Connection(std::shared_ptr<ControlPlaneNormalizedState> state, const protos::Connection& message) :
//   ControlPlaneStateBase(message),
//   m_root_state(std::move(state)),
//   m_message(message)
// {}

uint64_t Executor::id() const
{
    return m_message.id();
}

std::string Executor::peer_info() const
{
    return m_message.peer_info();
}

std::map<uint64_t, const Worker&> Executor::workers() const
{
    std::map<uint64_t, const Worker&> child_objs;

    for (const auto& id : m_message.worker_ids())
    {
        child_objs.emplace(id, MAP_AT_WITH_CHECK(m_root_state->workers, id));
    }

    return child_objs;
}

std::map<uint64_t, const PipelineInstance&> Executor::assigned_pipelines() const
{
    std::map<uint64_t, const PipelineInstance&> child_objs;

    for (const auto& id : m_message.assigned_pipeline_ids())
    {
        child_objs.emplace(id, MAP_AT_WITH_CHECK(m_root_state->pipeline_instances, id));
    }

    return child_objs;
}

std::map<uint64_t, const PipelineDefinition&> Executor::mapped_pipeline_definitions() const
{
    std::map<uint64_t, const PipelineDefinition&> child_objs;

    for (const auto& id : m_message.mapped_pipeline_definitions())
    {
        child_objs.emplace(id, MAP_AT_WITH_CHECK(m_root_state->pipeline_definitions, id));
    }

    return child_objs;
}

// Worker::Worker(std::shared_ptr<ControlPlaneNormalizedState> state, const protos::Worker& message) :
//   ControlPlaneStateBase(message),
//   m_root_state(std::move(state)),
//   m_message(message),
//   m_state(message.state())
// {}

uint64_t Worker::id() const
{
    return m_message.id();
}

std::string Worker::ucx_address() const
{
    return m_message.ucx_address();
}

uint64_t Worker::executor_id() const
{
    return m_message.executor_id();
}

const Executor& Worker::executor() const
{
    return MAP_AT_WITH_CHECK(m_root_state->executors, this->executor_id());
}

std::map<uint64_t, const SegmentInstance&> Worker::assigned_segments() const
{
    std::map<uint64_t, const SegmentInstance&> child_objs;

    for (const auto& id : m_message.assigned_segment_ids())
    {
        child_objs.emplace(id, MAP_AT_WITH_CHECK(m_root_state->segment_instances, id));
    }

    return child_objs;
}

PipelineConfiguration::PipelineConfiguration(const protos::PipelineConfiguration& message) :
  ControlPlaneStateBase(message),
  m_message(message)
{}

PipelineDefinition::ManifoldDefinition::ManifoldDefinition(
    std::shared_ptr<ControlPlaneNormalizedState> state,
    const protos::PipelineDefinition_ManifoldDefinition& message) :
  ControlPlaneStateBase(message),
  m_message(message)
{}

uint64_t PipelineDefinition::ManifoldDefinition::id() const
{
    return m_message.id();
}

const PipelineDefinition& PipelineDefinition::ManifoldDefinition::parent() const
{
    return MAP_AT_WITH_CHECK(m_root_state->pipeline_definitions, m_message.parent_id());
}

std::string PipelineDefinition::ManifoldDefinition::port_name() const
{
    return m_message.port_name();
}

std::map<uint64_t, std::reference_wrapper<const ManifoldInstance>> PipelineDefinition::ManifoldDefinition::instances()
    const
{
    std::map<uint64_t, std::reference_wrapper<const ManifoldInstance>> child_objs;

    for (const auto& id : m_message.instance_ids())
    {
        child_objs.emplace(id, MAP_AT_WITH_CHECK(m_root_state->manifold_instances, id));
    }

    return child_objs;
}

PipelineDefinition::SegmentDefinition::SegmentDefinition(std::shared_ptr<ControlPlaneNormalizedState> state,
                                                         const protos::PipelineDefinition_SegmentDefinition& message) :
  ControlPlaneStateBase(message),
  m_message(message)
{}

uint64_t PipelineDefinition::SegmentDefinition::id() const
{
    return m_message.id();
}

const PipelineDefinition& PipelineDefinition::SegmentDefinition::parent() const
{
    return MAP_AT_WITH_CHECK(m_root_state->pipeline_definitions, m_message.parent_id());
}

std::string PipelineDefinition::SegmentDefinition::name() const
{
    return m_message.name();
}

std::map<uint64_t, std::reference_wrapper<const SegmentInstance>> PipelineDefinition::SegmentDefinition::instances()
    const
{
    std::map<uint64_t, std::reference_wrapper<const SegmentInstance>> child_objs;

    for (const auto& id : m_message.instance_ids())
    {
        child_objs.emplace(id, MAP_AT_WITH_CHECK(m_root_state->segment_instances, id));
    }

    return child_objs;
}

PipelineDefinition::PipelineDefinition(std::shared_ptr<ControlPlaneNormalizedState> state,
                                       const protos::PipelineDefinition& message) :
  ControlPlaneTopLevelMessage(state, message),
  m_config(message.config())
{
    // Setup the manifolds
    for (const auto& [man_id, man_def] : m_message.manifolds())
    {
        m_manifolds.emplace(man_id, ManifoldDefinition(state, man_def));
    }

    // Now setup the segments
    for (const auto& [seg_id, seg_def] : m_message.segments())
    {
        m_segments.emplace(seg_id, SegmentDefinition(state, seg_def));
    }
}

uint64_t PipelineDefinition::id() const
{
    return m_message.id();
}

const PipelineConfiguration& PipelineDefinition::config() const
{
    return m_config;
}

std::map<uint64_t, std::reference_wrapper<const PipelineInstance>> PipelineDefinition::instances() const
{
    std::map<uint64_t, std::reference_wrapper<const PipelineInstance>> child_objs;

    for (const auto& id : m_message.instance_ids())
    {
        child_objs.emplace(id, MAP_AT_WITH_CHECK(m_root_state->pipeline_instances, id));
    }

    return child_objs;
}

const std::map<std::string, PipelineDefinition::ManifoldDefinition>& PipelineDefinition::manifolds() const
{
    return m_manifolds;
}

const std::map<std::string, PipelineDefinition::SegmentDefinition>& PipelineDefinition::segments() const
{
    return m_segments;
}

// PipelineInstance::PipelineInstance(std::shared_ptr<ControlPlaneNormalizedState> state,
//                                    const protos::PipelineInstance& message) :
//   ControlPlaneStateBase(message),
//   m_root_state(std::move(state)),
//   m_message(message),
//   m_state(message.state())
// {}

uint64_t PipelineInstance::id() const
{
    return m_message.id();
}

const PipelineDefinition& PipelineInstance::definition() const
{
    return MAP_AT_WITH_CHECK(m_root_state->pipeline_definitions, m_message.definition_id());
}

uint64_t PipelineInstance::executor_id() const
{
    return m_message.executor_id();
}

std::map<uint64_t, std::reference_wrapper<const ManifoldInstance>> PipelineInstance::manifolds() const
{
    std::map<uint64_t, std::reference_wrapper<const ManifoldInstance>> child_objs;

    for (const auto& id : m_message.manifold_ids())
    {
        child_objs.emplace(id, MAP_AT_WITH_CHECK(m_root_state->manifold_instances, id));
    }

    return child_objs;
}

std::map<uint64_t, std::reference_wrapper<const SegmentInstance>> PipelineInstance::segments() const
{
    std::map<uint64_t, std::reference_wrapper<const SegmentInstance>> child_objs;

    for (const auto& id : m_message.segment_ids())
    {
        child_objs.emplace(id, MAP_AT_WITH_CHECK(m_root_state->segment_instances, id));
    }

    return child_objs;
}

uint64_t ManifoldInstance::id() const
{
    return m_message.id();
}

const PipelineDefinition& ManifoldInstance::pipeline_definition() const
{
    return MAP_AT_WITH_CHECK(m_root_state->pipeline_definitions, m_message.pipeline_definition_id());
}

std::string ManifoldInstance::port_name() const
{
    return m_message.port_name();
}

uint64_t ManifoldInstance::executor_id() const
{
    return m_message.executor_id();
}

const PipelineInstance& ManifoldInstance::pipeline_instance() const
{
    return MAP_AT_WITH_CHECK(m_root_state->pipeline_instances, m_message.pipeline_instance_id());
}

std::map<SegmentAddressCombined2, bool> ManifoldInstance::requested_output_segments() const
{
    std::map<SegmentAddressCombined2, bool> mapping;

    for (const auto& [seg_id, is_local] : m_message.requested_output_segments())
    {
        mapping.emplace(seg_id, is_local);
    }

    return mapping;
}

std::map<SegmentAddressCombined2, bool> ManifoldInstance::requested_input_segments() const
{
    std::map<SegmentAddressCombined2, bool> mapping;

    for (const auto& [seg_id, is_local] : m_message.requested_input_segments())
    {
        mapping.emplace(seg_id, is_local);
    }

    return mapping;
}

// SegmentInstance::SegmentInstance(std::shared_ptr<ControlPlaneNormalizedState> state,
//                                  const protos::SegmentInstance& message) :
//   ControlPlaneStateBase(message),
//   m_root_state(std::move(state)),
//   m_message(message),
//   m_state(message.state())
// {}

uint64_t SegmentInstance::id() const
{
    return m_message.id();
}

uint64_t SegmentInstance::executor_id() const
{
    return m_message.executor_id();
}

uint64_t SegmentInstance::pipeline_instance_id() const
{
    return m_message.pipeline_instance_id();
}

uint64_t SegmentInstance::segment_address() const
{
    return m_message.segment_address();
}

const PipelineDefinition& SegmentInstance::pipeline_definition() const
{
    return MAP_AT_WITH_CHECK(m_root_state->pipeline_definitions, m_message.pipeline_definition_id());
}

std::string SegmentInstance::name() const
{
    return m_message.name();
}

const Worker& SegmentInstance::worker() const
{
    return MAP_AT_WITH_CHECK(m_root_state->workers, m_message.worker_id());
}

const PipelineInstance& SegmentInstance::pipeline_instance() const
{
    return MAP_AT_WITH_CHECK(m_root_state->pipeline_instances, m_message.pipeline_instance_id());
}

// const ResourceState& SegmentInstance::state() const
// {
//     return m_state;
// }

}  // namespace mrc::control_plane::state
