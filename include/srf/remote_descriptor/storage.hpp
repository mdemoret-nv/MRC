/**
 * SPDX-FileCopyrightText: Copyright (c) 2022, NVIDIA CORPORATION & AFFILIATES. All rights reserved.
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

#include "srf/codable/encode.hpp"
#include "srf/codable/encoded_object.hpp"
#include "srf/utils/macros.hpp"

#include <cstdint>
#include <memory>

namespace srf::remote_descriptor {

class Storage
{
  public:
    Storage(std::shared_ptr<codable::EncodedObject> encoding);
    virtual ~Storage() = default;

    DELETE_COPYABILITY(Storage);
    DELETE_MOVEABILITY(Storage);

    const codable::EncodedObject& encoded_object() const;

    std::size_t tokens_count() const;
    std::size_t decrement_tokens(std::size_t decrement_count);

  protected:
    // codable::EncodedObject& encoded_object();

  private:
    std::shared_ptr<codable::EncodedObject> m_encoding;
    std::atomic<std::int32_t> m_tokens{INT32_MAX};
};

template <typename T>
class TypedStorage final : public Storage
{
    TypedStorage(T&& object, std::shared_ptr<codable::EncodedObject> encoded_object) :
      Storage(std::move(encoded_object)),
      m_object(std::move(object))
    {}

  public:
    static std::unique_ptr<TypedStorage<T>> create(T&& object, std::shared_ptr<codable::EncodedObject> encoded_object)
    {
        srf::codable::encode(object, *encoded_object);
        return std::unique_ptr<TypedStorage<T>>(new TypedStorage(std::move(object), std::move(encoded_object)));
    }

  private:
    T m_object;
};

template <typename T>
class TypedStorage<std::unique_ptr<T>> : public Storage
{
  public:
    TypedStorage(std::unique_ptr<T> object) : Storage(srf::codable::encode(*object)), m_object(std::move(object)) {}

  private:
    std::unique_ptr<T> m_object;
};

}  // namespace srf::remote_descriptor
