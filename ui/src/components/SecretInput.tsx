import { HStack, VStack } from "@astryxdesign/core/Stack"
import { Text } from "@astryxdesign/core/Text"
import { TextInput } from "@astryxdesign/core/TextInput"
import { useState } from "react"

import { maskSecret } from "../../../src/lib/credential-value"
import { CopyIcon, EyeIcon, EyeOffIcon } from "../icons"
import { useToast } from "../lib/toast"
import { IconAction } from "./common"

interface SecretInputProps {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  isDisabled?: boolean
  isRequired?: boolean
  isLabelHidden?: boolean
}

export function SecretInput({
  label,
  value,
  onChange,
  placeholder,
  isDisabled,
  isRequired,
  isLabelHidden,
}: SecretInputProps) {
  const [visible, setVisible] = useState(false)
  const toast = useToast()

  async function copy() {
    try {
      await navigator.clipboard.writeText(value)
      toast.success("Copied")
    } catch {
      toast.error("Could not copy the value to the clipboard")
    }
  }

  return (
    <VStack gap={1} style={{ flex: 1, minWidth: 0 }}>
      <HStack gap={1} vAlign="end">
        <div style={{ flex: 1, minWidth: 0 }}>
          <TextInput
            label={label}
            value={value}
            onChange={onChange}
            type={visible ? "text" : "password"}
            placeholder={placeholder}
            isDisabled={isDisabled}
            isRequired={isRequired}
            isLabelHidden={isLabelHidden}
            width="100%"
            ref={(element) => {
              if (element) {
                element.autocomplete = "off"
                element.spellcheck = false
              }
            }}
          />
        </div>
        <IconAction
          label={`${visible ? "Hide" : "Reveal"} ${label}`}
          icon={visible ? <EyeOffIcon /> : <EyeIcon />}
          isDisabled={isDisabled || !value}
          onClick={() => setVisible((current) => !current)}
        />
        <IconAction
          label={`Copy ${label}`}
          icon={<CopyIcon />}
          isDisabled={isDisabled || !value}
          onClick={copy}
        />
      </HStack>
      {value && !visible ?
        <Text type="code" color="secondary">
          {maskSecret(value)}
        </Text>
      : null}
    </VStack>
  )
}
