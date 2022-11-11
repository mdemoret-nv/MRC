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

#include "internal/resources/forward.hpp"
#include "internal/ucx/memory_block.hpp"

#include "srf/codable/encoded_object.hpp"
#include "srf/memory/buffer.hpp"
#include "srf/memory/buffer_view.hpp"
#include "srf/memory/memory_kind.hpp"
#include "srf/memory/resources/memory_resource.hpp"

#include <glog/logging.h>

#include <optional>

namespace srf::internal::remote_descriptor {

class EncodedObject : public srf::codable::EncodedObject
{
  public:
    EncodedObject(resources::PartitionResources& resources) : m_resources(resources) {}
    EncodedObject(codable::protos::EncodedObject proto, resources::PartitionResources& resources) :
      srf::codable::EncodedObject(std::move(proto)),
      m_resources(resources)
    {}

    // register memory region
    // may return nullopt if the region is considered too small
    std::optional<codable::idx_t> register_memory_view(srf::memory::const_buffer_view view,
                                                       bool force_register = false) final;

    // copy to eager descriptor
    codable::idx_t copy_to_eager_descriptor(srf::memory::const_buffer_view view) final;

    // create a buffer owned by this
    codable::idx_t create_memory_buffer(std::size_t bytes) final;

    // access a buffer created from
    srf::memory::buffer_view mutable_memory_buffer(const codable::idx_t& idx) const final;

  protected:
    void copy_from_buffer(const codable::idx_t& idx, srf::memory::buffer_view dst_view) const final
    {
        CHECK_LT(idx, descriptor_count());
        const auto& desc = proto().descriptors().at(idx);

        if (desc.has_eager_desc())
        {
            return copy_from_eager_buffer(idx, dst_view);
        }

        if (desc.has_remote_desc())
        {
            return copy_from_registered_buffer(idx, dst_view);
        }

        LOG(FATAL) << "descriptor " << idx << " not backed by a buffered resource";
    }

    std::shared_ptr<srf::memory::memory_resource> host_memory_resource() const final;
    std::shared_ptr<srf::memory::memory_resource> device_memory_resource() const final;

  private:
    void copy_from_registered_buffer(const codable::idx_t& idx, srf::memory::buffer_view& dst_view) const;

    void copy_from_eager_buffer(const codable::idx_t& idx, srf::memory::buffer_view& dst_view) const;

    /**
     * @brief Converts a memory block to a RemoteMemoryDescriptor proto
     */
    static void encode_descriptor(const InstanceID& instance_id,
                                  codable::protos::RemoteMemoryDescriptor& desc,
                                  srf::memory::const_buffer_view view,
                                  const ucx::MemoryBlock& ucx_block,
                                  bool should_cache = false);

    static srf::memory::buffer_view decode_descriptor(const codable::protos::RemoteMemoryDescriptor& desc);

    resources::PartitionResources& m_resources;
    std::map<codable::idx_t, srf::memory::buffer> m_buffers;
    std::vector<srf::memory::const_buffer_view> m_temporary_registrations;
};

}  // namespace srf::internal::remote_descriptor