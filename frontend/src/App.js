import { useState } from "react";
import "@chatscope/chat-ui-kit-styles/dist/default/styles.min.css";
import {
  MainContainer,
  ChatContainer,
  MessageList,
  Message,
  MessageInput,
  TypingIndicator
} from "@chatscope/chat-ui-kit-react";

function App() {
  const [messages, setMessages] = useState([
    {
      message: "Hallo! Wie kann ich dir helfen?",
      sender: "bot",
      direction: "incoming"
    }
  ]);

  const [isTyping, setIsTyping] = useState(false);

  const handleSend = async (text) => {
    if (!text) return;

    // Add user message to UI
    const userMessage = {
      message: text,
      sender: "user",
      direction: "outgoing"
    };
    setMessages((prev) => [...prev, userMessage]);
    setIsTyping(true);

    try {
      // 🔥 Call your Azure Static Web App API
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ message: text })
      });

      const data = await response.json();

      // Bot response from API
      const botMessage = {
        message: data.reply || "Keine Antwort erhalten 😕",
        sender: "bot",
        direction: "incoming"
      };

      setMessages((prev) => [...prev, botMessage]);
    } catch (err) {
      console.error("API Fehler:", err);

      setMessages((prev) => [
        ...prev,
        {
          message: "Fehler bei der Serveranfrage ❌",
          sender: "bot",
          direction: "incoming"
        }
      ]);
    }

    setIsTyping(false);
  };

  return (
    <div style={{ height: "100vh" }}>
      <MainContainer>
        <ChatContainer>
          <MessageList typingIndicator={isTyping ? <TypingIndicator content="Bot schreibt..." /> : null}>
            {messages.map((msg, index) => (
              <Message key={index} model={msg} />
            ))}
          </MessageList>
          <MessageInput placeholder="Nachricht eingeben..." onSend={handleSend} />
        </ChatContainer>
      </MainContainer>
    </div>
  );
}

export default App;
