"use client";

import React, { useState, useRef, useEffect } from "react";
import { Send, Mic, MicOff, Power, Upload, Menu } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import * as RadioGroup from "@radix-ui/react-radio-group";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Player, Recorder } from "@/lib/audio";
import { WebSocketClient } from "@/lib/client";
import ThemeSelector from "@/components/theme-selector";

interface Message {
  id: string;
  type: "user" | "assistant" | "status";
  content: string;
}

type WSControlAction = "speech_started" | "connected" | "text_done";

interface WSMessage {
  id?: string;
  type: "text_delta" | "transcription" | "user_message" | "control";
  delta?: string;
  text?: string;
  action?: WSControlAction;
  greeting?: string;
}

const useAudioHandlers = () => {
  const audioPlayerRef = useRef<Player | null>(null);
  const audioRecorderRef = useRef<Recorder | null>(null);

  const initAudioPlayer = async () => {
    if (!audioPlayerRef.current) {
      audioPlayerRef.current = new Player();
      await audioPlayerRef.current.init(24000);
    }
    return audioPlayerRef.current;
  };

  const handleAudioRecord = async (
    webSocketClient: WebSocketClient | null,
    isRecording: boolean
  ) => {
    if (!isRecording && webSocketClient) {
      if (!audioRecorderRef.current) {
        audioRecorderRef.current = new Recorder(async (buffer) => {
          await webSocketClient?.send({ type: "binary", data: buffer });
        });
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          sampleRate: 24000,
        },
      });
      await audioRecorderRef.current.start(stream);
      return true;
    } else if (audioRecorderRef.current) {
      await audioRecorderRef.current.stop();
      audioRecorderRef.current = null;
      return false;
    }
    return isRecording;
  };

  return {
    audioPlayerRef,
    audioRecorderRef,
    initAudioPlayer,
    handleAudioRecord,
  };
};

const ChatInterface = () => {
  const [endpoint, setEndpoint] = useState("ws://localhost:8080/realtime");
  const [messages, setMessages] = useState<Message[]>([]);
  const [currentMessage, setCurrentMessage] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [validEndpoint, setValidEndpoint] = useState(true);
  const [selectedModel, setSelectedModel] = useState("azure");
  const [isMenuOpen, setIsMenuOpen] = useState(true);

  const webSocketClient = useRef<WebSocketClient | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messageMap = useRef(new Map<string, Message>());
  const currentConnectingMessage = useRef<Message>();
  const currentUserMessage = useRef<Message>();

  const { audioPlayerRef, audioRecorderRef, initAudioPlayer, handleAudioRecord } =
    useAudioHandlers();

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleFileUpload = async (file: File) => {
    if (selectedModel !== "phi3") return;
    const formData = new FormData();
    formData.append("file", file);

    try {
      const response = await fetch("http://localhost:8080/upload", {
        method: "POST",
        body: formData,
      });
      const data = await response.json();
      const uploadResponse: Message = {
        id: `upload-${Date.now()}`,
        type: "assistant",
        content: data.message || "File uploaded and processed successfully.",
      };
      setMessages((prev) => [...prev, uploadResponse]);
    } catch (error) {
      console.error("File upload failed:", error);
    }
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      handleFileUpload(file);
    }
  };

  const handleWSMessage = async (message: WSMessage) => {
    switch (message.type) {
      case "transcription":
        if (message.id) {
          currentUserMessage.current!.content = message.text!;
          setMessages(Array.from(messageMap.current.values()));
        }
        break;
      case "text_delta":
        if (message.id) {
          const existingMessage = messageMap.current.get(message.id);
          if (existingMessage) {
            existingMessage.content += message.delta!;
          } else {
            const newMessage: Message = {
              id: message.id,
              type: "assistant",
              content: message.delta!,
            };
            messageMap.current.set(message.id, newMessage);
          }
          setMessages(Array.from(messageMap.current.values()));
        }
        break;
      case "control":
        if (message.action === "connected" && message.greeting) {
          currentConnectingMessage.current!.content = message.greeting!;
          setMessages(Array.from(messageMap.current.values()));
        } else if (message.action === "speech_started") {
          audioPlayerRef.current?.clear();
          const contrivedId = "userMessage" + Math.random();
          currentUserMessage.current = {
            id: contrivedId,
            type: "user",
            content: "...",
          };
          messageMap.current.set(contrivedId, currentUserMessage.current);
          setMessages(Array.from(messageMap.current.values()));
        }
        break;
    }
  };

  const receiveLoop = async () => {
    const player = await initAudioPlayer();
    if (!webSocketClient.current) return;

    for await (const message of webSocketClient.current) {
      if (message.type === "text") {
        const data = JSON.parse(message.data) as WSMessage;
        await handleWSMessage(data);
      } else if (message.type === "binary" && player) {
        player.play(new Int16Array(message.data));
      }
    }
  };

  const handleConnect = async () => {
    if (selectedModel === "phi3") {
      // Send prompt to /phi3 endpoint
      // try {
      //   const response = await fetch("http://localhost:8080/phi3", {
      //     method: "POST",
      //     headers: { "Content-Type": "application/json" },
      //     body: JSON.stringify({ prompt: currentMessage }),
      //   });
      //   const data = await response.json();
      //   const newMessage: Message = {
      //     id: `assistant-${Date.now()}`,
      //     type: "assistant",
      //     content: data.response || "Response received.",
      //   };
      //   setMessages((prev) => [...prev, newMessage]);
      // } catch (error) {
      //   console.error("Error calling Phi-3 API:", error);
      // }
      setIsConnected(true);
      return; // Skip WebSocket connection if Phi-3
    }

    if (isConnected) {
      await disconnect();
    } else {
      const statusMessageId = `status-${Date.now()}`;
      currentConnectingMessage.current = {
        id: statusMessageId,
        type: "status",
        content: "Connecting...",
      };
      messageMap.current.clear();
      messageMap.current.set(statusMessageId, currentConnectingMessage.current);
      setMessages(Array.from(messageMap.current.values()));
      setIsConnecting(true);
      try {
        webSocketClient.current = new WebSocketClient(new URL(endpoint));
        setIsConnected(true);
        receiveLoop();
      } catch (error) {
        console.error("Connection failed:", error);
      } finally {
        setIsConnecting(false);
      }
    }
  };

  const disconnect = async () => {
    setIsConnected(false);
    if (isRecording) {
      await toggleRecording();
    }
    audioRecorderRef.current?.stop();
    await audioPlayerRef.current?.clear();
    await webSocketClient.current?.close();
    webSocketClient.current = null;
    messageMap.current.clear();
    setMessages([]);
  };

  const sendMessage = async () => {
    if (currentMessage.trim()) {
      const messageId = `user-${Date.now()}`;
      const newMessage: Message = {
        id: messageId,
        type: "user",
        content: currentMessage,
      };
      messageMap.current.set(messageId, newMessage);
      setMessages(Array.from(messageMap.current.values()));
      setCurrentMessage("");

      if (selectedModel === "phi3") {
        try {
          const response = await fetch("http://localhost:8080/phi3", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt: newMessage.content }),
          });
          const data = await response.json();
          const assistantMsgId = `assistant-${Date.now()}`;
          const assistantMsg: Message = {
            id: assistantMsgId,
            type: "assistant",
            content: data.response || "Response received.",
          };
            messageMap.current.set(assistantMsgId, assistantMsg);
            setMessages(Array.from(messageMap.current.values()));
        } catch (err) {
          console.error("Error sending to Phi-3:", err);
        }
      } else if (webSocketClient.current) {
        await webSocketClient.current.send({
          type: "text",
          data: JSON.stringify({ type: "user_message", text: newMessage.content }),
        });
      }
    }
  };

  const toggleRecording = async () => {
    try {
      const newRecordingState = await handleAudioRecord(
        webSocketClient.current,
        isRecording
      );
      setIsRecording(newRecordingState);
    } catch (error) {
      console.error("Recording error:", error);
      setIsRecording(false);
    }
  };

  useEffect(() => {
    return () => {
      disconnect();
    };
  }, []);

  const validateEndpoint = (url: string) => {
    setEndpoint(url);
    try {
      new URL(url);
      setValidEndpoint(true);
    } catch {
      setValidEndpoint(false);
    }
  };

  return (
    <div className="flex h-screen bg-background text-foreground">
      {isMenuOpen && (
        <div className="w-80 bg-background p-4 flex flex-col border-r border-border">
          <div className="flex-1 overflow-y-auto">
            <Accordion type="single" className="space-y-4" value="connection">
              <AccordionItem value="connection">
                <AccordionTrigger className="text-lg font-semibold">
                <span className="font-montserrat orange">MEGANEXUS</span>
                </AccordionTrigger>
                <AccordionContent className="space-y-4">
                <Input
                  placeholder="Endpoint"
                  value={endpoint}
                  onChange={(e) => validateEndpoint(e.target.value)}
                  disabled={isConnected}
                />
                <RadioGroup.Root
                  className="space-y-2"
                  value={selectedModel}
                  onValueChange={(val) => setSelectedModel(val)}
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
                    <label htmlFor="azure" className="text-sm">
                      Azure OpenAI
                    </label>
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
                    <label htmlFor="phi3" className="text-sm">
                      Phi-3
                    </label>
                  </div>
                </RadioGroup.Root>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>
        <div className="mt-4 flex items-center gap-2">
          <Button
            variant={isConnected ? "destructive" : "default"}
            onClick={handleConnect}
            disabled={isConnecting || !validEndpoint}
          >
            <Power className="w-4 h-4 mr-2" />
            {isConnecting ? "Connecting..." : isConnected ? "Disconnect" : "Connect"}
          </Button>
          <ThemeSelector />

        </div>
      </div>)}

      <div className="flex-1 flex flex-col">
        <div className="p-4 border-b flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setIsMenuOpen(!isMenuOpen)}
            aria-label="Toggle menu"
          >
            <Menu className="w-5 h-5" />
          </Button>
          <span className="font-montserrat orange text-xl">MEGANEXUS</span>
        </div>
        <div className="flex-1 p-4 overflow-y-auto">
          <div className="space-y-4">
            {messages.map((message) => (
              <div
                key={message.id}
                className={`p-3 rounded-lg ${
                  message.type === "user"
                    ? "bg-primary text-primary-foreground ml-auto max-w-[80%]"
                    : message.type === "status"
                    ? "bg-muted text-muted-foreground mx-auto max-w-[80%] text-center"
                    : "bg-secondary text-secondary-foreground mr-auto max-w-[80%]"
                }`}
              >
                {message.content}
              </div>
            ))}
          </div>
          <div ref={messagesEndRef} />
        </div>

        <div className="p-4 border-t">
          <div className="flex gap-2 items-center">
            <Input
              value={currentMessage}
              onChange={(e) => setCurrentMessage(e.target.value)}
              placeholder="Type your message..."
              onKeyUp={(e) => e.key === "Enter" && sendMessage()}
              disabled={!isConnected || selectedModel !== "phi3"}
            />
            <Button
              variant="outline"
              onClick={toggleRecording}
              className={isRecording ? "bg-destructive text-destructive-foreground" : ""}
              disabled={!isConnected || selectedModel !== "phi3"}
            >
              {isRecording ? <Mic className="w-4 h-4" /> : <MicOff className="w-4 h-4" />}
            </Button>
            <Button
              onClick={sendMessage}
              disabled={!isConnected || selectedModel !== "phi3"}
            >
              <Send className="w-4 h-4" />
            </Button>
            <label htmlFor="file-upload" className="cursor-pointer">
              <Upload className="w-5 h-5" />
            </label>
            <input
              id="file-upload" 
              type="file"
              accept=".pdf,.doc,.docx,.txt"
              onChange={handleFileChange}
              className="hidden"
              disabled={!isConnected || selectedModel !== "phi3"}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export default ChatInterface;
