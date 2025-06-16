// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { get } from "http";
import { Player } from "./player.ts";
import { Recorder } from "./recorder.ts";
import "./style.css";
import { LowLevelRTClient, ResponseDoneMessage, ResponseOutputItemDoneMessage, RTClient, SessionUpdateMessage, Voice } from "rt-client";

let realtimeStreaming: LowLevelRTClient;
let audioRecorder: Recorder;
let audioPlayer: Player;
let sawFunctionCall = false;



async function start_realtime(endpoint: string, apiKey: string, deploymentOrModel: string) {
  if (isAzureOpenAI()) {
    realtimeStreaming = new LowLevelRTClient(new URL(endpoint), { key: apiKey }, { deployment: deploymentOrModel });
  } else {
    realtimeStreaming = new LowLevelRTClient({ key: apiKey }, { model: deploymentOrModel });
  }

  try {
    console.log("sending session config");
    await realtimeStreaming.send(createConfigMessage(deploymentOrModel));
  } catch (error) {
    console.log(error);
    makeNewTextBlock("[Connection error]: Unable to send initial config message. Please check your endpoint and authentication details.");
    setFormInputState(InputState.ReadyToStart);
    return;
  }
  console.log("sent");
  await Promise.all([resetAudio(true), handleRealtimeMessages()]);
}

function createConfigMessage(deploymentOrModel: string): SessionUpdateMessage {

  let configMessage: SessionUpdateMessage = {
    type: "session.update",
    session: {
      instructions: "Ask for the company name and postcode, then validate the response",//getBusinessInfoInstructionTemplate(),
      model: deploymentOrModel,
      turn_detection: {
        type: "server_vad",
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 500,
      
      },
      input_audio_transcription:{
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
                description: "The name of the company"
              },
              postcode: {
                type: "string",
                description: "The postcode of the company"
              }
            },
            required: ["companyName", "postcode"]
          }
        },
        // {
        //   type: "function",
        //   name: "get_weather_for_location",
        //   description: "Get the weather for a location",
        //   parameters: {
        //     type: "object",
        //     properties: {
        //       location: { type: "string", description: "City, e.g. Pune, India" },
        //       unit: { type: "string", enum: ["c", "f"], description: "Celsius or Fahrenheit" }
        //     },
        //     required: ["location", "unit"],
        //   },
        // },
      ],
    },
  };

  const systemMessage = getSystemMessage();
  const temperature = getTemperature();
  const voice = getVoice();

  if (systemMessage) {
    configMessage.session.instructions = systemMessage;
  }
  if (!isNaN(temperature)) {
    configMessage.session.temperature = temperature;
  }
  if (voice) {
    configMessage.session.voice = voice;
  }

  return configMessage;
}
async function getWeatherForLocation(location: string, unit: string) {
  // Stubbed data; swap in a real API if desired

  return {
    location,
    temperature: 25,
    unit,
    description: "Sunny with some clouds",
  };
}

async function handleFunctionCall(message: ResponseOutputItemDoneMessage) {
  console.log("Function call", message);
  let item = message.item;
  if (item.type === "function_call") {
    sawFunctionCall = true;

    // 5a) Parse the arguments
    let args;
    try {
      args = JSON.parse(item.arguments);
    } catch (e) {
      console.error("❌ Could not parse function_call arguments:", e);
      return;
    }

    console.log("📥 Function call args:", args);

    // 5b) Invoke your tool
    let result;
    try {
      // result = await getWeatherForLocation(args.location, args.unit);
      result = await getCompanyInfo(args.companyName, args.postcode);
    } catch (e) {
      console.error("❌ Tool execution failed:", e);
      result = { error: "Tool failed" };
    }

    console.log("🔧 Tool result:", result);

    // 5c) Inject the function_call_output
    await realtimeStreaming.send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: item.call_id,              // guaranteed non-null here
        output: JSON.stringify(result),
      },
    });
    // Don’t send response.create yet—wait for the model’s response.done
  }
}

async function handleRealtimeMessages() {
  for await (const message of realtimeStreaming.messages()) {
    let consoleLog = "" + message.type;

    switch (message.type) {
      case "session.created":
        setFormInputState(InputState.ReadyToStop);
        makeNewTextBlock("<< Session Started >>");
        makeNewTextBlock();
        break;
      case "response.audio_transcript.delta":
        appendToTextBlock(message.delta);
        break;
      case "response.audio.delta":
        const binary = atob(message.delta);
        const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
        const pcmData = new Int16Array(bytes.buffer);
        audioPlayer.play(pcmData);
        break;

      case "input_audio_buffer.speech_started":
        makeNewTextBlock("<< Speech Started >>");
        let textElements = formReceivedTextContainer.children;
        latestInputSpeechBlock = textElements[textElements.length - 1];
        makeNewTextBlock();
        audioPlayer.clear();
        break;
      case "conversation.item.input_audio_transcription.completed":
        latestInputSpeechBlock.textContent += " User: " + message.transcript;
        break;
      case "response.done":
        handleResponseDone(message);
        formReceivedTextContainer.appendChild(document.createElement("hr"));
        break;
      case "response.output_item.done":
        handleFunctionCall(message);
        break;
      default:
        consoleLog = JSON.stringify(message, null, 2);
        break
    }
    if (consoleLog) {
      console.log(consoleLog);
    }
  }
  resetAudio(false);
}

/**
 * Basic audio handling
 */

let recordingActive: boolean = false;
let buffer: Uint8Array = new Uint8Array();

function combineArray(newData: Uint8Array) {
  const newBuffer = new Uint8Array(buffer.length + newData.length);
  newBuffer.set(buffer);
  newBuffer.set(newData, buffer.length);
  buffer = newBuffer;
}

function processAudioRecordingBuffer(data: Buffer) {
  const uint8Array = new Uint8Array(data);
  combineArray(uint8Array);
  if (buffer.length >= 4800) {
    const toSend = new Uint8Array(buffer.slice(0, 4800));
    buffer = new Uint8Array(buffer.slice(4800));
    const regularArray = String.fromCharCode(...toSend);
    const base64 = btoa(regularArray);
    if (recordingActive) {
      realtimeStreaming.send({
        type: "input_audio_buffer.append",
        audio: base64,
      });
    }
  }

}

async function resetAudio(startRecording: boolean) {
  recordingActive = false;
  if (audioRecorder) {
    audioRecorder.stop();
  }
  if (audioPlayer) {
    audioPlayer.clear();
  }
  audioRecorder = new Recorder(processAudioRecordingBuffer);
  audioPlayer = new Player();
  audioPlayer.init(24000);
  if (startRecording) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioRecorder.start(stream);
    recordingActive = true;
  }
}

/**
 * UI and controls
 */

const formReceivedTextContainer = document.querySelector<HTMLDivElement>(
  "#received-text-container",
)!;
const formStartButton =
  document.querySelector<HTMLButtonElement>("#start-recording")!;
const formStopButton =
  document.querySelector<HTMLButtonElement>("#stop-recording")!;
const formClearAllButton =
  document.querySelector<HTMLButtonElement>("#clear-all")!;
const formEndpointField =
  document.querySelector<HTMLInputElement>("#endpoint")!;
const formAzureToggle =
  document.querySelector<HTMLInputElement>("#azure-toggle")!;
const formApiKeyField = document.querySelector<HTMLInputElement>("#api-key")!;
const formDeploymentOrModelField = document.querySelector<HTMLInputElement>("#deployment-or-model")!;
const formSessionInstructionsField =
  document.querySelector<HTMLTextAreaElement>("#session-instructions")!;
const formTemperatureField = document.querySelector<HTMLInputElement>("#temperature")!;
const formVoiceSelection = document.querySelector<HTMLInputElement>("#voice")!;

let latestInputSpeechBlock: Element;

enum InputState {
  Working,
  ReadyToStart,
  ReadyToStop,
}

function isAzureOpenAI(): boolean {
  return formAzureToggle.checked;
}

function guessIfIsAzureOpenAI() {
  const endpoint = (formEndpointField.value || "").trim();
  formAzureToggle.checked = endpoint.indexOf('azure') > -1;
}

function setFormInputState(state: InputState) {
  formEndpointField.disabled = state != InputState.ReadyToStart;
  formApiKeyField.disabled = state != InputState.ReadyToStart;
  formDeploymentOrModelField.disabled = state != InputState.ReadyToStart;
  formStartButton.disabled = state != InputState.ReadyToStart;
  formStopButton.disabled = state != InputState.ReadyToStop;
  formSessionInstructionsField.disabled = state != InputState.ReadyToStart;
  formAzureToggle.disabled = state != InputState.ReadyToStart;
}

function getSystemMessage(): string {
  return formSessionInstructionsField.value || "";
}

function getTemperature(): number {
  return parseFloat(formTemperatureField.value);
}

function getVoice(): Voice {
  return formVoiceSelection.value as Voice;
}

function makeNewTextBlock(text: string = "") {
  let newElement = document.createElement("p");
  newElement.textContent = text;
  formReceivedTextContainer.appendChild(newElement);
}

function appendToTextBlock(text: string) {
  let textElements = formReceivedTextContainer.children;
  if (textElements.length == 0) {
    makeNewTextBlock();
  }
  textElements[textElements.length - 1].textContent += text;
}

formStartButton.addEventListener("click", async () => {
  setFormInputState(InputState.Working);

  const endpoint = formEndpointField.value.trim();
  const key = formApiKeyField.value.trim();
  const deploymentOrModel = formDeploymentOrModelField.value.trim();

  if (isAzureOpenAI() && !endpoint && !deploymentOrModel) {
    alert("Endpoint and Deployment are required for Azure OpenAI");
    return;
  }

  if (!isAzureOpenAI() && !deploymentOrModel) {
    alert("Model is required for OpenAI");
    return;
  }

  if (!key) {
    alert("API Key is required");
    return;
  }

  try {
    start_realtime(endpoint, key, deploymentOrModel);
  } catch (error) {
    console.log(error);
    setFormInputState(InputState.ReadyToStart);
  }
});

formStopButton.addEventListener("click", async () => {
  setFormInputState(InputState.Working);
  resetAudio(false);
  realtimeStreaming.close();
  setFormInputState(InputState.ReadyToStart);
});

formClearAllButton.addEventListener("click", async () => {
  formReceivedTextContainer.innerHTML = "";
});

formEndpointField.addEventListener('change', async () => {
  guessIfIsAzureOpenAI();
});
guessIfIsAzureOpenAI();


async function handleResponseDone(message: ResponseDoneMessage) {
  console.log("🔚 Response done event triggered", message);
  if (sawFunctionCall) {
    // This done is the end of the function_call segment → resume the model
    sawFunctionCall = false;
    await realtimeStreaming.send({ type: "response.create" });
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

function getBusinessInfoInstructionTemplate(): string {
  console.log('Getting business information instructions');

  const baseInstructions = `You are John, a business consultant having a conversation to gather information about a company.

    Ask the following questions one at a time, waiting for a response before moving to the next question:
    1. What is the name of your company?
    2. What is your business postcode?
    3. Is this an existing business or are you looking to start a new one?
    4. What are the main aims of your business?
    5. What are your core business activities?
    6. How many employees do you currently have?
    7. What is your approximate annual turnover?
    8. What are your business aspirations for the next 3-5 years?

    Be professional but friendly in your approach. If you receive unclear or incomplete answers, politely ask for clarification.


    After gathering all the information, provide a brief summary of what you've learned about their business and ask if there's anything they'd like to add or modify.
   
    Remember that you are a human and not a machine, you speak with human flaws and emotions,
    occasionally making mistakes and using filler words such as 'um'.
    Whilst bearing this in mind, remember that you are the expert, and you should speak with confidence on the topic of your company.

    Keep your responses concise and focused on the specific job requirements.

    React accordingly to negative/closed answers or positive/open answers.
    `;

  return baseInstructions;
}


function getCompanyInfo(companyName: any, postcode: any): Promise<any> {
  console.log("Getting company info for:", companyName, postcode);
  const url = "http://localhost:8000/exemplas-api/api/v1/companieshouse/validate";
  const data = {
    companyName: companyName,
    postcode: postcode,
  };

  const options = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  };

  return fetch(url, options)
    .then((response) => {
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      return response.json();
    })
    .then((result) => {
      console.log("Company Info Response:", result);
      //{\"status\":\"match_found\",\"message\":\"Active company found matching details.\",\"matched_company\":{\"company_name\":\"HEYDON INVESTMENTS LIMITED\",\"company_number\":\"11163462\",\"address_snippet\":\"104 High Street London Colney, St. Albans\"},\"matching_companies\":null}
      //create a string with all attributes of the matched_company
      let matchedCompany = result.matched_company;
      if (matchedCompany) {
        result= `Company Name: ${matchedCompany.company_name}, Company Number: ${matchedCompany.company_number}, Address Snippet: ${matchedCompany.address_snippet}`;
      }
      
      return result;
    })
    .catch((error) => {
      console.error("Error fetching company info:", error);
      return { error: "Failed to fetch company info" };
    });
}

