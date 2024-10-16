/*
 * SPDX-FileCopyrightText: Copyright (c) 2021-2023, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
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

#include "mrc/channel/buffered_channel.hpp"
#include "mrc/channel/status.hpp"
#include "mrc/edge/edge_writable.hpp"
#include "mrc/exceptions/runtime_error.hpp"
#include "mrc/node/forward.hpp"
#include "mrc/node/node_parent.hpp"
#include "mrc/node/sink_channel_owner.hpp"
#include "mrc/node/sink_properties.hpp"
#include "mrc/node/source_channel_owner.hpp"
#include "mrc/node/source_properties.hpp"
#include "mrc/runnable/forward.hpp"
#include "mrc/runnable/runnable.hpp"
#include "mrc/utils/string_utils.hpp"

#include <boost/fiber/condition_variable.hpp>

#include <map>
#include <memory>
#include <queue>
#include <stop_token>
#include <type_traits>

namespace mrc::node {

template <typename KeyT, typename InputT, typename OutputT = InputT>
class RouterBase : public ForwardingWritableProvider<InputT>, public MultiSourceProperties<KeyT, OutputT>
{
  public:
    using input_data_t  = InputT;
    using output_data_t = OutputT;

    RouterBase() : ForwardingWritableProvider<input_data_t>() {}

    std::shared_ptr<edge::IWritableAcceptor<output_data_t>> get_source(const KeyT& key) const
    {
        // Simply return an object that will set the message to upstream and go away
        return std::make_shared<DownstreamEdge>(*const_cast<RouterBase<KeyT, InputT, OutputT>*>(this), key);
    }

    bool has_source(const KeyT& key) const
    {
        return MultiSourceProperties<KeyT, output_data_t>::get_edge_pair(key).first;
    }

    void drop_source(const KeyT& key)
    {
        MultiSourceProperties<KeyT, output_data_t>::release_edge_connection(key);
    }

  protected:
    class DownstreamEdge : public edge::IWritableAcceptor<output_data_t>
    {
      public:
        DownstreamEdge(RouterBase& parent, KeyT key) : m_parent(parent), m_key(std::move(key)) {}

        void set_writable_edge_handle(std::shared_ptr<edge::WritableEdgeHandle> ingress) override
        {
            // Make sure we do any type conversions as needed
            auto adapted_ingress = edge::EdgeBuilder::adapt_writable_edge<OutputT>(std::move(ingress));

            m_parent.MultiSourceProperties<KeyT, OutputT>::make_edge_connection(m_key, std::move(adapted_ingress));
        }

      private:
        RouterBase<KeyT, input_data_t, output_data_t>& m_parent;
        KeyT m_key;
    };

    void on_complete() override
    {
        MultiSourceProperties<KeyT, output_data_t>::release_edge_connections();
    }
};

template <typename KeyT, typename InputT, typename OutputT = InputT, typename = void>
class Router;

template <typename KeyT, typename InputT, typename OutputT>
class Router<KeyT,
             InputT,
             OutputT,
             std::enable_if_t<!std::is_same_v<InputT, OutputT> && !std::is_convertible_v<InputT, OutputT>>>
  : public RouterBase<KeyT, InputT, OutputT>
{
  protected:
    channel::Status on_next(InputT&& data) override
    {
        try
        {
            KeyT key    = this->determine_key_for_value(data);
            auto output = this->convert_value(std::move(data));

            return MultiSourceProperties<KeyT, OutputT>::get_writable_edge(key)->await_write(std::move(output));
        } catch (const std::exception& e)
        {
            LOG(ERROR) << "Caught exception: " << e.what() << std::endl;
            return channel::Status::error;
        }
    }

    virtual KeyT determine_key_for_value(const InputT& t) = 0;

    virtual OutputT convert_value(InputT&& data) = 0;
};

template <typename KeyT, typename InputT, typename OutputT>
class Router<KeyT,
             InputT,
             OutputT,
             std::enable_if_t<std::is_same_v<InputT, OutputT> || std::is_convertible_v<InputT, OutputT>>>
  : public RouterBase<KeyT, InputT, OutputT>
{
  protected:
    channel::Status on_next(InputT&& data) override
    {
        try
        {
            KeyT key = this->determine_key_for_value(data);
            return MultiSourceProperties<KeyT, OutputT>::get_writable_edge(key)->await_write(std::move(data));
        } catch (const std::exception& e)
        {
            LOG(ERROR) << "Caught exception: " << e.what() << std::endl;
            return channel::Status::error;
        }
    }

    virtual KeyT determine_key_for_value(const InputT& t) = 0;
};

template <typename KeyT, typename InputT, typename OutputT = InputT, typename = void>
class LambdaRouter;

template <typename KeyT, typename InputT, typename OutputT>
class LambdaRouter<KeyT,
                   InputT,
                   OutputT,
                   std::enable_if_t<!std::is_same_v<InputT, OutputT> && !std::is_convertible_v<InputT, OutputT>>>
  : public Router<KeyT, InputT, OutputT>
{
  public:
    using key_fn_t     = std::function<KeyT(const InputT&)>;
    using convert_fn_t = std::function<OutputT(InputT&&)>;

    LambdaRouter(key_fn_t key_fn, convert_fn_t convert_fn) :
      m_key_fn(std::move(key_fn)),
      m_convert_fn(std::move(convert_fn))
    {}

  protected:
    KeyT determine_key_for_value(const InputT& t) override
    {
        return this->m_key_fn(t);
    }

    OutputT convert_value(InputT&& data) override
    {
        return this->m_convert_fn(std::move(data));
    }

    key_fn_t m_key_fn;
    convert_fn_t m_convert_fn;
};

template <typename KeyT, typename InputT, typename OutputT>
class LambdaRouter<KeyT,
                   InputT,
                   OutputT,
                   std::enable_if_t<std::is_same_v<InputT, OutputT> || std::is_convertible_v<InputT, OutputT>>>
  : public Router<KeyT, InputT, OutputT>
{
  public:
    using key_fn_t = std::function<KeyT(const InputT&)>;

    LambdaRouter(key_fn_t key_fn) : m_key_fn(std::move(key_fn)) {}

  protected:
    KeyT determine_key_for_value(const InputT& t) override
    {
        return this->m_key_fn(t);
    }

    key_fn_t m_key_fn;
};

template <typename KeyT, typename T>
class TaggedRouter : public Router<KeyT, std::pair<KeyT, T>, T>
{
  protected:
    using typename RouterBase<KeyT, std::pair<KeyT, T>, T>::input_data_t;
    using typename RouterBase<KeyT, std::pair<KeyT, T>, T>::output_data_t;

    KeyT determine_key_for_value(const input_data_t& data) override
    {
        return data.first;
    }

    output_data_t convert_value(input_data_t&& data) override
    {
        // TODO(MDD): Do we need to move the key too?

        output_data_t tmp = std::move(data.second);
        return tmp;
    }
};

template <typename KeyT, typename InputT>
class DynamicRouterComponent : public ForwardingWritableProvider<InputT>,
                               public MultiWritableAcceptor<KeyT, InputT>,
                               public HomogeneousNodeParent<edge::IWritableAcceptor<InputT>>
{
  public:
    using this_t   = DynamicRouterComponent<KeyT, InputT>;
    using key_t    = KeyT;
    using input_t  = InputT;
    using key_fn_t = std::function<key_t(const input_t&)>;

    DynamicRouterComponent(std::vector<key_t> route_keys, key_fn_t key_fn) : m_key_fn(std::move(key_fn))
    {
        // Create a downstream for each key
        for (const auto& key : route_keys)
        {
            m_downstreams[key] = std::make_shared<Downstream>(*this, key);
        }
    }

    std::shared_ptr<edge::IWritableAcceptor<input_t>> get_source(const KeyT& key) const
    {
        return m_downstreams.at(key);
    }

    bool has_source(const key_t& key) const
    {
        return m_downstreams.contains(key);
    }

    void drop_source(const key_t& key)
    {
        // TODO(MDD): Do we want to even support this?
        m_downstreams.erase(key);

        // MultiSourceProperties<key_t, input_t>::release_writable_edge(key);
    }

    std::map<std::string, std::reference_wrapper<typename this_t::child_node_t>> get_children_refs(
        std::optional<std::string> child_name = std::nullopt) const override
    {
        std::map<std::string, std::reference_wrapper<typename this_t::child_node_t>> children;

        for (const auto& [key, downstream] : m_downstreams)
        {
            children.emplace(key, std::ref(*downstream));
        }

        return children;
    }

  protected:
    class Downstream : public edge::IWritableAcceptor<input_t>
    {
      public:
        Downstream(DynamicRouterComponent& parent, key_t key) : m_parent(parent), m_key(std::move(key)) {}

        void set_writable_edge_handle(std::shared_ptr<edge::WritableEdgeHandle> ingress) override
        {
            m_parent.MultiWritableAcceptor<key_t, input_t>::set_writable_edge_handle(m_key, std::move(ingress));
        }

      private:
        DynamicRouterComponent& m_parent;
        key_t m_key;
    };

    channel::Status on_next(input_t&& data) override
    {
        try
        {
            key_t key = this->determine_key_for_value(data);
            return MultiSourceProperties<key_t, input_t>::get_writable_edge(key)->await_write(std::move(data));
        } catch (const std::exception& e)
        {
            LOG(ERROR) << "Caught exception: " << e.what() << std::endl;
            return channel::Status::error;
        }
    }

    key_t determine_key_for_value(const InputT& t)
    {
        return m_key_fn(t);
    }

    void on_complete() override
    {
        MultiSourceProperties<key_t, input_t>::release_edge_connections();
    }

    key_fn_t m_key_fn;

    std::map<key_t, std::shared_ptr<edge::IWritableAcceptor<input_t>>> m_downstreams;
};

template <typename InputT>
class RouterDownstreamNode : public edge::IWritableAcceptor<InputT>,
                             public edge::IReadableProvider<InputT>,
                             public ISourceChannelOwner<InputT>
{};

template <typename KeyT, typename InputT>
class StaticRouterBase : public MultiWritableAcceptor<KeyT, InputT>,
                         public MultiReadableProvider<KeyT, InputT>,
                         public MultiSourceChannelOwner<KeyT, InputT>,
                         public HomogeneousNodeParent<RouterDownstreamNode<InputT>>
{
  public:
    using this_t   = StaticRouterBase<KeyT, InputT>;
    using key_t    = KeyT;
    using input_t  = InputT;
    using key_fn_t = std::function<key_t(const input_t&)>;

    StaticRouterBase(std::vector<key_t> route_keys)
    {
        // Create a downstream for each key
        for (const auto& key : route_keys)
        {
            m_downstreams[key] = std::make_shared<Downstream>(*this, key);
        }
    }

    std::shared_ptr<edge::IWritableAcceptor<input_t>> get_source(const KeyT& key) const
    {
        return m_downstreams.at(key);
    }

    bool has_source(const key_t& key) const
    {
        return m_downstreams.contains(key);
    }

    std::map<std::string, std::reference_wrapper<typename this_t::child_node_t>> get_children_refs(
        std::optional<std::string> child_name = std::nullopt) const override
    {
        std::map<std::string, std::reference_wrapper<typename this_t::child_node_t>> children;

        for (const auto& [key, downstream] : m_downstreams)
        {
            // Utilize MRC_CONCAT_STR to convert the type to a string as best we can
            children.emplace(MRC_CONCAT_STR(key), std::ref(*downstream));
        }

        return children;
    }

  protected:
    class Downstream : public RouterDownstreamNode<input_t>
    {
      public:
        Downstream(StaticRouterBase& parent, KeyT key) : m_parent(parent), m_key(std::move(key))
        {
            this->set_channel(std::make_unique<mrc::channel::BufferedChannel<input_t>>());
        }

        void set_channel(std::unique_ptr<mrc::channel::Channel<input_t>> channel) override
        {
            m_parent.MultiSourceChannelOwner<key_t, input_t>::set_channel(m_key, std::move(channel));
        }

        void set_writable_edge_handle(std::shared_ptr<edge::WritableEdgeHandle> ingress) override
        {
            m_parent.MultiWritableAcceptor<key_t, input_t>::set_writable_edge_handle(m_key, std::move(ingress));
        }

        std::shared_ptr<edge::ReadableEdgeHandle> get_readable_edge_handle() const override
        {
            return m_parent.MultiReadableProvider<key_t, input_t>::get_readable_edge_handle(m_key);
        }

      private:
        StaticRouterBase& m_parent;
        KeyT m_key;
    };

    channel::Status process_one(InputT&& data)
    {
        try
        {
            key_t key = this->determine_key_for_value(data);
            return MultiSourceProperties<key_t, input_t>::get_writable_edge(key)->await_write(std::move(data));
        } catch (const std::exception& e)
        {
            LOG(ERROR) << "Caught exception: " << e.what() << std::endl;
            return channel::Status::error;
        }
    }

    virtual key_t determine_key_for_value(const InputT& t) = 0;

    std::map<key_t, std::shared_ptr<Downstream>> m_downstreams;
};

template <typename KeyT, typename InputT>
class StaticRouterComponentBase : public ForwardingWritableProvider<InputT>, public StaticRouterBase<KeyT, InputT>
{
  public:
    using base_t   = StaticRouterBase<KeyT, InputT>;
    using key_t    = KeyT;
    using input_t  = InputT;
    using key_fn_t = std::function<key_t(const input_t&)>;

    using base_t::base_t;

  protected:
    channel::Status on_next(InputT&& data) override
    {
        return this->process_one(std::move(data));
    }

    void on_complete() override
    {
        MultiSourceProperties<KeyT, InputT>::release_edge_connections();
    }
};

template <typename KeyT, typename InputT>
class LambdaStaticRouterComponent : public StaticRouterComponentBase<KeyT, InputT>
{
  public:
    using base_t   = StaticRouterComponentBase<KeyT, InputT>;
    using key_t    = KeyT;
    using input_t  = InputT;
    using key_fn_t = std::function<key_t(const input_t&)>;

    LambdaStaticRouterComponent(std::vector<key_t> route_keys, key_fn_t key_fn) :
      base_t(std::move(route_keys)),
      m_key_fn(std::move(key_fn))
    {}

  protected:
    key_t determine_key_for_value(const InputT& t) override
    {
        return m_key_fn(t);
    }

    key_fn_t m_key_fn;
};

template <typename KeyT, typename InputT>
class StaticRouterRunnableBase : public WritableProvider<InputT>,
                                 public ReadableAcceptor<InputT>,
                                 public SinkChannelOwner<InputT>,
                                 public StaticRouterBase<KeyT, InputT>,
                                 public mrc::runnable::RunnableWithContext<>
{
  public:
    using this_t   = StaticRouterRunnableBase<KeyT, InputT>;
    using base_t   = StaticRouterBase<KeyT, InputT>;
    using key_t    = KeyT;
    using input_t  = InputT;
    using key_fn_t = std::function<key_t(const input_t&)>;

    StaticRouterRunnableBase(std::vector<key_t> route_keys) : base_t(std::move(route_keys))
    {
        SinkChannelOwner<InputT>::set_channel(std::make_unique<mrc::channel::BufferedChannel<input_t>>());
    }

  private:
    /**
     * @brief Runnable's entrypoint.
     */
    void run(mrc::runnable::Context& ctx) override
    {
        InputT data;
        channel::Status read_status;
        channel::Status write_status = channel::Status::success;  // give an initial value

        // Loop until either the node has been killed or the upstream terminated
        while (!m_stop_source.stop_requested() &&
               (read_status = this->get_readable_edge()->await_read(data)) == channel::Status::success &&
               write_status == channel::Status::success)
        {
            write_status = this->process_one(std::move(data));
        }

        // Drop all connections
        MultiSourceProperties<KeyT, InputT>::release_edge_connections();

        if (read_status == channel::Status::error)
        {
            throw exceptions::MrcRuntimeError("Failed to read from upstream");
        }

        if (write_status == channel::Status::error)
        {
            throw exceptions::MrcRuntimeError("Failed to write to downstream");
        }
    }

    /**
     * @brief Runnable's state control, for stopping from MRC.
     */
    void on_state_update(const mrc::runnable::Runnable::State& state) final
    {
        switch (state)
        {
        case mrc::runnable::Runnable::State::Stop:
            // Do nothing, we wait for the upstream channel to return closed
            // m_stop_source.request_stop();
            break;

        case mrc::runnable::Runnable::State::Kill:
            m_stop_source.request_stop();
            break;

        default:
            break;
        }
    }

    std::stop_source m_stop_source;
};

template <typename KeyT, typename InputT>
class LambdaStaticRouterRunnable : public StaticRouterRunnableBase<KeyT, InputT>
{
  public:
    using base_t   = StaticRouterRunnableBase<KeyT, InputT>;
    using key_t    = KeyT;
    using input_t  = InputT;
    using key_fn_t = std::function<key_t(const input_t&)>;

    LambdaStaticRouterRunnable(std::vector<key_t> route_keys, key_fn_t key_fn) :
      base_t(std::move(route_keys)),
      m_key_fn(std::move(key_fn))
    {}

  protected:
    key_t determine_key_for_value(const InputT& t) override
    {
        return m_key_fn(t);
    }

    key_fn_t m_key_fn;
};

}  // namespace mrc::node
