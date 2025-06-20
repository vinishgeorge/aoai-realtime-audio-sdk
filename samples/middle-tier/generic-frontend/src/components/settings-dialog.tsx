"use client";

import * as React from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import * as RadioGroup from "@radix-ui/react-radio-group";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  endpoint: string;
  onEndpointChange: (value: string) => void;
  selectedModel: string;
  onModelChange: (value: string) => void;
  isConnected: boolean;
}

export default function SettingsDialog({
  open,
  onOpenChange,
  endpoint,
  onEndpointChange,
  selectedModel,
  onModelChange,
  isConnected,
}: Props) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-background text-foreground p-4 rounded-md shadow-lg space-y-4 w-80">
        <Input
          placeholder="Endpoint"
          value={endpoint}
          onChange={(e) => onEndpointChange(e.target.value)}
          disabled={isConnected}
        />
        <RadioGroup.Root
          className="space-y-2"
          value={selectedModel}
          onValueChange={onModelChange}
        >
          <div className="flex items-center gap-2">
            <RadioGroup.Item
              className="bg-white w-5 h-5 rounded-full border border-gray-400 data-[state=checked]:bg-blue-600"
              value="azure"
              id="azure"
            >
              <RadioGroup.Indicator className="flex items-center justify-center w-full h-full">
                <div className="w-2 h-2 bg-white rounded-full" />
              </RadioGroup.Indicator>
            </RadioGroup.Item>
            <label htmlFor="azure" className="text-sm">Azure OpenAI</label>
          </div>
          <div className="flex items-center gap-2">
            <RadioGroup.Item
              className="bg-white w-5 h-5 rounded-full border border-gray-400 data-[state=checked]:bg-green-600"
              value="phi3"
              id="phi3"
            >
              <RadioGroup.Indicator className="flex items-center justify-center w-full h-full">
                <div className="w-2 h-2 bg-white rounded-full" />
              </RadioGroup.Indicator>
            </RadioGroup.Item>
            <label htmlFor="phi3" className="text-sm">Phi-3</label>
          </div>
        </RadioGroup.Root>
        <div className="text-right">
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        </div>
      </div>
    </div>
  );
}
