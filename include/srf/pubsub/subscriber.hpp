/**
 * SPDX-FileCopyrightText: Copyright (c) 2021-2022, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

#pragma once

#include "rxcpp/operators/rx-map.hpp"

#include "srf/codable/decode.hpp"
#include "srf/codable/encoded_object.hpp"
#include "srf/core/runtime.hpp"
#include "srf/node/edge_builder.hpp"
#include "srf/node/queue.hpp"
#include "srf/node/rx_node.hpp"
#include "srf/node/rx_source.hpp"
#include "srf/node/sink_channel.hpp"
#include "srf/node/source_channel.hpp"
#include "srf/node/source_properties.hpp"
#include "srf/remote_descriptor/storage.hpp"
#include "srf/runnable/launch_control.hpp"
#include "srf/runnable/launch_options.hpp"
#include "srf/types.hpp"
#include "srf/utils/macros.hpp"

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <utility>

namespace srf::pubsub {

template <typename T>
class Subscriber;

class SubscriberBase : public runnable::Runnable
{
    using state_t = runnable::Runnable::State;

  public:
    using connections_changed_handler_t = std::function<void(const std::unordered_map<std::uint64_t, InstanceID>&)>;

    const std::string& service_name() const;
    const std::uint64_t& tag() const;

    // void set_tagged_instances(const std::string& role,
    //                           const std::unordered_map<std::uint64_t, InstanceID>& tagged_instances)
    // {
    //     // todo - convert tagged instances -> tagged endpoints
    //     m_tagged_instances = tagged_instances;
    //     for (const auto& [tag, instance_id] : m_tagged_instances)
    //     {
    //         m_tagged_endpoints[tag] = resources().network()->data_plane().client().endpoint_shared(instance_id);
    //     }
    //     m_subscriber->on_update();
    // }

    std::unique_ptr<runnable::Runner> link_service(
        std::uint64_t tag,
        std::function<void()> drop_service_fn,
        runnable::LaunchControl& launch_control,
        runnable::LaunchOptions& launch_options,
        node::SourceProperties<std::unique_ptr<codable::EncodedObject>>& source);

    void update_tagged_instances(const std::unordered_map<std::uint64_t, InstanceID>& tagged_instances);

    void register_connections_changed_handler(connections_changed_handler_t on_changed_fn);

  protected:
    SubscriberBase(std::string service_name, core::IRuntime& runtime);

    const std::unordered_map<std::uint64_t, InstanceID>& get_tagged_instances() const;

    std::unique_ptr<codable::EncodedObject> get_encoded_obj() const;

    void push_object(std::uint64_t id, std::unique_ptr<remote_descriptor::Storage> storage);

    virtual void on_tagged_instances_updated();

    node::SourceChannel<codable::EncodedObject>& get_network_source();

  private:
    void main(runnable::Context& context) final;
    void on_state_update(const state_t& state) final;

    virtual std::unique_ptr<runnable::Runner> do_link_service(
        std::uint64_t tag,
        std::function<void()> drop_service_fn,
        runnable::LaunchControl& launch_control,
        runnable::LaunchOptions& launch_options,
        node::SourceProperties<std::unique_ptr<codable::EncodedObject>>& source) = 0;

    core::IRuntime& m_runtime;
    std::atomic<bool> m_running{false};
    const std::string m_service_name;
    std::uint64_t m_tag;
    std::unordered_map<std::uint64_t, InstanceID> m_tagged_instances;

    std::vector<connections_changed_handler_t> m_on_connections_changed_fns;

    // friend SubscriberManager;
};

class SubscriberEdgeBase
{
  public:
    DELETE_COPYABILITY(SubscriberEdgeBase);
    DELETE_MOVEABILITY(SubscriberEdgeBase);

    const std::string& service_name();

    const std::uint64_t& tag();

    void register_connections_changed_handler(SubscriberBase::connections_changed_handler_t on_changed_fn);

  protected:
    SubscriberEdgeBase(SubscriberBase& parent);

  private:
    SubscriberBase& m_parent;
};

template <typename T>
class SubscriberEdge : public node::SinkChannelReadable<T>, public node::SourceChannel<T>, public SubscriberEdgeBase
{
    SubscriberEdge(Subscriber<T>& parent) : SubscriberEdgeBase(parent) {}

  public:
    ~SubscriberEdge() = default;

    // static std::shared_ptr<SubscriberEdge<T>> make_pub_service(std::unique_ptr<Subscriber<T>> pub,
    //                                                           core::IRuntime& runtime)
    // {
    //     // Get a future to the edge object
    //     auto edge_fut = pub->get_edge();

    //     // Call the function to build the subscriber service
    //     auto drop_sub_fn = make_pub_service(std::move(pub), runtime);
    // }

  private:
    // Subscriber<T>& m_parent;

    // friend void make_pub_service(std::shared_ptr<SubscriberBase> subscriber, core::IRuntime& runtime);

    // std::function<void()> m_drop_service_fn{};

    // Only allow subscriber to make this class
    friend Subscriber<T>;

    // // Allow this function to finish setting up m_drop_service_fn
    // template <typename SubscriberT, typename... ArgsT>
    // friend auto make_subscriber(std::string name, core::IRuntime& runtime, ArgsT&&... args);
};

template <typename T>
class Subscriber : public SubscriberBase
{
    Subscriber(std::string service_name, core::IRuntime& runtime) : SubscriberBase(std::move(service_name), runtime) {}

  public:
    using data_t = T;

    ~Subscriber() override = default;

    // DELETE_COPYABILITY(Subscriber);
    // DELETE_MOVEABILITY(Subscriber);

    std::unique_ptr<runnable::Runner> do_link_service(
        std::uint64_t tag,
        std::function<void()> drop_service_fn,
        runnable::LaunchControl& launch_control,
        runnable::LaunchOptions& launch_options,
        node::SourceProperties<std::unique_ptr<codable::EncodedObject>>& source) override
    {
        // Now that we have the tag and drop service function, make the edge object
        auto edge =
            std::shared_ptr<SubscriberEdge<T>>(new SubscriberEdge<T>(*this), [drop_service_fn](SubscriberEdge<T>* ptr) {
                // Call the function to stop the service
                drop_service_fn();
                delete ptr;
            });

        // Create the sink runnable that will serve as the progress engine
        auto node = std::make_unique<srf::node::RxNode<std::unique_ptr<codable::EncodedObject>, T>>(
            rxcpp::operators::map([this](std::unique_ptr<codable::EncodedObject> data) {
                // Forward to our class
                return this->on_data(std::move(data));
            }));

        // Link the incoming stream to our node
        srf::node::make_edge(source, *node);

        // Link our node to the edge
        srf::node::make_edge(*node, *edge);

        auto writer = launch_control.prepare_launcher(launch_options, std::move(node))->ignition();

        // Set the new edge to the edge future
        m_edge_promise.set_value(std::move(edge));

        return writer;
    }

  private:
    Future<std::shared_ptr<SubscriberEdge<T>>> get_edge()
    {
        // CHECK(m_edge_promise) << "Edge was already used or service was not properly connectd!";

        return m_edge_promise.get_future();
    }

    virtual T on_data(std::unique_ptr<codable::EncodedObject> object)
    {
        auto val = codable::decode<T>(*object);

        return val;
    }

    Promise<std::shared_ptr<SubscriberEdge<T>>> m_edge_promise;

    // friend SubscriberManager;

    template <typename SubscriberT, typename... ArgsT>
    friend auto make_subscriber(std::string name, core::IRuntime& runtime, ArgsT&&... args);
};

template <typename SubscriberT, typename... ArgsT>
auto make_subscriber(std::string name, core::IRuntime& runtime, ArgsT&&... args)
{
    // Assert that SubscriberT derives from subscriber

    // Get the data type
    using data_t = typename SubscriberT::data_t;

    // // Create the edge object
    // auto pub_edge = std::make_shared<SubscriberEdge<data_t>>();

    // Create the actual subscriber
    auto pub = std::unique_ptr<SubscriberT>(new SubscriberT(std::move(name), runtime, std::forward<ArgsT>(args)...));

    // Get a future to the edge that will be created during make_pub_service
    auto pub_edge_future = pub->get_edge();

    // Now build the service
    make_pub_service(std::move(pub), runtime);

    // // Now set the drop function into the subscriber edge
    // pub_edge->m_drop_service_fn = std::move(drop_service_fn);

    // Finally, return the edge
    return pub_edge_future.get();
}

void make_pub_service(std::unique_ptr<SubscriberBase> subscriber, core::IRuntime& runtime);

}  // namespace srf::pubsub