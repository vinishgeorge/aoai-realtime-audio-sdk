"use client";

import React, { useState, useRef, useEffect } from "react";
import { Plus, Send, Mic, MicOff, Power } from "lucide-react";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  Modality,
  RTClient,
  RTInputAudioItem,
  RTResponse,
  TurnDetection,
  LowLevelRTClient,
  SessionUpdateMessage,
  ResponseDoneMessage
} from "rt-client";
import { AudioHandler } from "@/lib/audio";

interface Message {
  type: "user" | "assistant" | "status";
  content: string;
}

interface ToolDeclaration {
  name: string;
  parameters: string;
  returnValue: string;
}

const ChatInterface = () => {
  const [isAzure, setIsAzure] = useState(true);
  const [apiKey, setApiKey] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [deployment, setDeployment] = useState("");
  const [useVAD, setUseVAD] = useState(true);
  const [instructions, setInstructions] = useState("");
  const [temperature, setTemperature] = useState(0.9);
  const [modality, setModality] = useState("audio");
  const [tools, setTools] = useState<ToolDeclaration[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [currentMessage, setCurrentMessage] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const clientRef = useRef<RTClient | null>(null);
  const realtimeStreaming = useRef<LowLevelRTClient | null>(null);
  const audioHandlerRef = useRef<AudioHandler | null>(null);
  const [sawFunctionCall, setSawFunctionCall] = useState(false);
  const playbackActive = useRef(false);
  const addTool = () => {
    setTools([...tools, { name: "", parameters: "", returnValue: "" }]);
  };

  const updateTool = (index: number, field: string, value: string) => {
    const newTools = [...tools];

    if (field === "name") {
      newTools[index].name = value;
    } else if (field === "parameters") {
      newTools[index].parameters = value;
    } else if (field === "returnValue") {
      newTools[index].returnValue = value;
    }
  };

  const handleConnect = async () => {
    if (!isConnected) {
      try {
        setIsConnecting(true);
        console.log("Connecting...", apiKey, endpoint, deployment);
        realtimeStreaming.current = new LowLevelRTClient(new URL(endpoint), { key: apiKey }, { deployment: deployment });
        await realtimeStreaming.current.send(createConfigMessage(deployment));
        // const modalities: Modality[] =
        //   modality === "audio" ? ["text", "audio"] : ["text"];
        // const turnDetection: TurnDetection = useVAD
        //   ? { type: "server_vad" }
        //   : null;

        // startResponseListener();
        handleRealtimeMessages();

        setIsConnected(true);
      } catch (error) {
        console.error("Connection failed:", error);
      } finally {
        setIsConnecting(false);
      }
    } else {
      await disconnect();
    }
  };

  const handleRealtimeMessages = async () => {
    if (!realtimeStreaming.current) return;
    for await (const message of realtimeStreaming.current.messages()) {
      let consoleLog = "" + message.type;
      switch (message.type) {
        case "session.created":
          consoleLog = "Session created";
          break;
        case "response.audio_transcript.delta":
          consoleLog = "Audio transcript delta";
          break;
        case "response.audio_transcript.done":
          consoleLog = "Audio transcript done";
          appendChatMessage(message.transcript, "assistant");
          break;
        case "response.audio.delta":

          await playAudio(message.delta);
          consoleLog = "Audio delta";
          break;
        case "response.audio.done":
          consoleLog = "Audio done";
          break;
        // case "response.function_call":
        case "input_audio_buffer.speech_started":
          consoleLog = "Speech started";
          if (playbackActive.current) {
            //add sleep before stopping
            audioHandlerRef.current?.stopStreamingPlayback();
            playbackActive.current = false;
          }
          break;
        case "conversation.item.input_audio_transcription.completed":
          consoleLog = "Input audio transcription completed";
          appendChatMessage(message.transcript, "user");
          break;
        case "response.done":
          consoleLog = "Response done";
          handleResponseDone(message);
          break;
        case "response.output_item.done":
          consoleLog = "Output item done";
          //handleFunctionCall(message);
          break;
        default:
          consoleLog = JSON.stringify(message, null, 2);
          break
      }
      if (consoleLog) {
        console.log(consoleLog);
      }
    }
  }

  const playAudio = async (audio: string) => {
    if (!audioHandlerRef.current) {
      return
    }
    if (!playbackActive.current) {
      playbackActive.current = true;
      audioHandlerRef.current?.startStreamingPlayback();
    }
    const binary = atob(audio);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    audioHandlerRef.current.playChunk(bytes);
  };

  const appendChatMessage = (message: string, role: "user" | "assistant" | "status") => {

    let currentMessage = {
      type: role,
      content: message,
    }
    setMessages((prevMessages) => [
      ...prevMessages,
      currentMessage
    ]);

  };
  const handleResponseDone = async (message: ResponseDoneMessage) => {
    if (!realtimeStreaming.current) return;
    console.log("🔚 Response done event triggered", message);
    if (sawFunctionCall) {
      // This done is the end of the function_call segment → resume the model
      setSawFunctionCall(false);
      await realtimeStreaming.current.send({
        type: "response.create"
      });
      return;
    } else {
      //print the final summary
      // check if the response has a summary
      // if (e.response.output[0].content[0].transcript) {
      //   console.log("Final summary:", e.response.output[0].content[0].transcript);
      // }
    }
    // Otherwise it’s the end of the summary turn → close
    console.log("✅ Conversation complete; closing socket.");
  }

  const createConfigMessage = (deploymentOrModel: string): SessionUpdateMessage => ({
    type: "session.update",
    session: {
      instructions: "Ask for the company name and postcode, then validate the response",
      model: deploymentOrModel,
      turn_detection: {
        type: "server_vad",
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 500,
      },
      input_audio_transcription: {
        model: "whisper-1",
      },
      temperature: 0.7,
      tools: [
        {
          type: "function",
          name: "get_company_info",
          description: "Get information about company by name and postcode",
          parameters: {
            type: "object",
            properties: {
              companyName: {
                type: "string",
                description: "The name of the company",
              },
              postcode: {
                type: "string",
                description: "The postcode of the company",
              },
            },
            required: ["companyName", "postcode"],
          },
        },
      ],
    },
  });


  const disconnect = async () => {
    if (realtimeStreaming.current) {
      try {
        await realtimeStreaming.current.close();
        realtimeStreaming.current = null;
        setIsConnected(false);
      } catch (error) {
        console.error("Disconnect failed:", error);
      }
    }
  };

  // const handleResponse = async (response: RTResponse) => {
  //   for await (const item of response) {
  //     if (item.type === "message" && item.role === "assistant") {
  //       const message: Message = {
  //         type: item.role,
  //         content: "",
  //       };
  //       setMessages((prevMessages) => [...prevMessages, message]);
  //       for await (const content of item) {
  //         if (content.type === "text") {
  //           for await (const text of content.textChunks()) {
  //             message.content += text;
  //             setMessages((prevMessages) => {
  //               prevMessages[prevMessages.length - 1].content = message.content;
  //               return [...prevMessages];
  //             });
  //           }
  //         } else if (content.type === "audio") {
  //           const textTask = async () => {
  //             for await (const text of content.transcriptChunks()) {
  //               message.content += text;
  //               setMessages((prevMessages) => {
  //                 prevMessages[prevMessages.length - 1].content =
  //                   message.content;
  //                 return [...prevMessages];
  //               });
  //             }
  //           };
  //           const audioTask = async () => {
  //             audioHandlerRef.current?.startStreamingPlayback();
  //             for await (const audio of content.audioChunks()) {
  //               audioHandlerRef.current?.playChunk(audio);
  //             }
  //           };
  //           await Promise.all([textTask(), audioTask()]);
  //         }
  //       }
  //     }
  //   }
  // };

  // const handleInputAudio = async (item: RTInputAudioItem) => {
  //   audioHandlerRef.current?.stopStreamingPlayback();
  //   await item.waitForCompletion();
  //   setMessages((prevMessages) => [
  //     ...prevMessages,
  //     {
  //       type: "user",
  //       content: item.transcription || "",
  //     },
  //   ]);
  // };

  // const startResponseListener = async () => {
  //   if (!clientRef.current) return;

  //   try {
  //     for await (const serverEvent of realtimeStreaming.current.events()) {
  //       if (serverEvent.type === "response") {
  //         await handleResponse(serverEvent);
  //       } else if (serverEvent.type === "input_audio") {
  //         await handleInputAudio(serverEvent);
  //       }
  //     }
  //   } catch (error) {
  //     if (clientRef.current) {
  //       console.error("Response iteration error:", error);
  //     }
  //   }
  // };

  const sendMessage = async () => {
    if (currentMessage.trim() && realtimeStreaming.current) {
      try {
        setMessages((prevMessages) => [
          ...prevMessages,
          {
            type: "user",
            content: currentMessage,
          },
        ]);

        await realtimeStreaming.current.send({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: currentMessage }]
          },
        });
        
        await realtimeStreaming.current.send({
          type: "response.create"
        });
        setCurrentMessage("");
      } catch (error) {
        console.error("Failed to send message:", error);
      }
    }
  };

  const toggleRecording = async () => {
    if (!isRecording && realtimeStreaming.current) {
      try {
        console.log("Starting recording...");
        if (!audioHandlerRef.current) {
          audioHandlerRef.current = new AudioHandler();
          await audioHandlerRef.current.initialize();
        }
        await audioHandlerRef.current.startRecording(async (chunk) => {
          // await realtimeStreaming.current?.sendAudio(chunk);
          const regularArray = String.fromCharCode(...chunk);
          const base64 = btoa(regularArray);
          await realtimeStreaming.current?.send({
            type: "input_audio_buffer.append",
            audio: base64,
          });
        });
        setIsRecording(true);
      } catch (error) {
        console.error("Failed to start recording:", error);
      }
    } else if (audioHandlerRef.current) {
      console.log("Stopping recording...");
      try {
        audioHandlerRef.current.stopRecording();
        if (!useVAD) {
          // const inputAudio = await realtimeStreaming.current?.send();
          // await handleInputAudio(inputAudio!);
        }
        setIsRecording(false);
      } catch (error) {
        console.error("Failed to stop recording:", error);
      }
    }
  };

  useEffect(() => {
    const initAudioHandler = async () => {
      const handler = new AudioHandler();
      await handler.initialize();
      audioHandlerRef.current = handler;
    };

    initAudioHandler().catch(console.error);

    return () => {
      disconnect();
      audioHandlerRef.current?.close().catch(console.error);
    };
  }, []);

  return (
    <div className="flex h-screen">
      {/* Parameters Panel */}
      <div className="w-80 bg-gray-50 p-4 flex flex-col border-r">
        <div className="flex-1 overflow-y-auto">
          <Accordion type="single" collapsible className="space-y-4">
            {/* Connection Settings */}
            <AccordionItem value="connection">
              <AccordionTrigger className="text-lg font-semibold">
                Connection Settings
              </AccordionTrigger>
              <AccordionContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <span>Use Azure OpenAI</span>
                  <Switch
                    checked={isAzure}
                    onCheckedChange={setIsAzure}
                    disabled={isConnected}
                  />
                </div>

                {isAzure && (
                  <>
                    <Input
                      placeholder="Azure Endpoint"
                      value={endpoint}
                      onChange={(e) => setEndpoint(e.target.value)}
                      disabled={isConnected}
                    />
                    <Input
                      placeholder="Deployment Name"
                      value={deployment}
                      onChange={(e) => setDeployment(e.target.value)}
                      disabled={isConnected}
                    />
                  </>
                )}

                <Input
                  type="password"
                  placeholder="API Key"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  disabled={isConnected}
                />
              </AccordionContent>
            </AccordionItem>

            {/* Conversation Settings */}
            <AccordionItem value="conversation">
              <AccordionTrigger className="text-lg font-semibold">
                Conversation Settings
              </AccordionTrigger>
              <AccordionContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <span>Use Server VAD</span>
                  <Switch
                    checked={useVAD}
                    onCheckedChange={setUseVAD}
                    disabled={isConnected}
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Instructions</label>
                  <textarea
                    placeholder="Instructions for the assistant"
                    className="w-full min-h-[100px] p-2 border rounded"
                    value={instructions}
                    onChange={(e) => setInstructions(e.target.value)}
                    disabled={isConnected}
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Tools</label>
                  {tools.map((tool, index) => (
                    <Card key={index} className="p-2">
                      <Input
                        placeholder="Function name"
                        value={tool.name}
                        onChange={(e) =>
                          updateTool(index, "name", e.target.value)
                        }
                        className="mb-2"
                        disabled={isConnected}
                      />
                      <Input
                        placeholder="Parameters"
                        value={tool.parameters}
                        onChange={(e) =>
                          updateTool(index, "parameters", e.target.value)
                        }
                        className="mb-2"
                        disabled={isConnected}
                      />
                      <Input
                        placeholder="Return value"
                        value={tool.returnValue}
                        onChange={(e) =>
                          updateTool(index, "returnValue", e.target.value)
                        }
                        disabled={isConnected}
                      />
                    </Card>
                  ))}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={addTool}
                    className="w-full"
                    disabled={isConnected || true}
                  >
                    <Plus className="w-4 h-4 mr-2" />
                    Add Tool
                  </Button>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">
                    Temperature ({temperature})
                  </label>
                  <Slider
                    value={[temperature]}
                    onValueChange={([value]) => setTemperature(value)}
                    min={0.6}
                    max={1.2}
                    step={0.1}
                    disabled={isConnected}
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Modality</label>
                  <Select
                    value={modality}
                    onValueChange={setModality}
                    disabled={isConnected}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="text">Text</SelectItem>
                      <SelectItem value="audio">Audio</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>

        {/* Connect Button */}
        <Button
          className="mt-4"
          variant={isConnected ? "destructive" : "default"}
          onClick={handleConnect}
          disabled={isConnecting}
        >
          <Power className="w-4 h-4 mr-2" />
          {isConnecting
            ? "Connecting..."
            : isConnected
              ? "Disconnect"
              : "Connect"}
        </Button>
      </div>

      {/* Chat Window */}
      <div className="flex-1 flex flex-col">
        {/* Messages Area */}
        <div className="flex-1 p-4 overflow-y-auto">
          {messages.map((message, index) => (
            <div
              key={index}
              className={`mb-4 p-3 rounded-lg ${message.type === "user"
                ? "bg-blue-100 ml-auto max-w-[80%]"
                : "bg-gray-100 mr-auto max-w-[80%]"
                }`}
            >
              {message.content}
            </div>
          ))}
        </div>

        {/* Input Area */}
        <div className="p-4 border-t">
          <div className="flex gap-2">
            <Input
              value={currentMessage}
              onChange={(e) => setCurrentMessage(e.target.value)}
              placeholder="Type your message..."
              onKeyUp={(e) => e.key === "Enter" && sendMessage()}
              disabled={!isConnected}
            />
            <Button
              variant="outline"
              onClick={toggleRecording}
              className={isRecording ? "bg-red-100" : ""}
              disabled={!isConnected}
            >
              {isRecording ? (
                <MicOff className="w-4 h-4" />
              ) : (
                <Mic className="w-4 h-4" />
              )}
            </Button>
            <Button onClick={sendMessage} disabled={!isConnected}>
              <Send className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ChatInterface;
