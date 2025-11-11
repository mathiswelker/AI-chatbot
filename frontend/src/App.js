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

    // User message
    const userMessage = {
      message: text,
      sender: "user",
      direction: "outgoing"
    };

    setMessages((prev) => [...prev, userMessage]);
    setIsTyping(true);

    // Fake bot answer for now
    setTimeout(() => {
      const botResponse = {
        message: "Das ist eine Beispielantwort 😊",
        sender: "bot",
        direction: "incoming"
      };
      setMessages((prev) => [...prev, botResponse]);
      setIsTyping(false);
    }, 1200);
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
