import { useState } from "react";
import Container from "../../../primitives/Container";
import Heading from "../../../primitives/Heading";
import Text from "../../../primitives/Text";
import Input from "../../../primitives/Input";
import Textarea from "../../../primitives/Textarea";
import Button from "../../../primitives/Button";
import type { NodeProps } from "../../../lib/types";

export interface ContactFormValues {
  name: string;
  email: string;
  message: string;
}

export interface ContactFormProps {
  heading: string;
  description: string;
  namePlaceholder: string;
  emailPlaceholder: string;
  messagePlaceholder: string;
  submitLabel: string;
  // Interactive seam (contract 4.3): wired to a no-op in mock data.
  onSubmit: (values: ContactFormValues) => void;
}

export default function ContactForm({
  nodeId,
  heading,
  description,
  namePlaceholder,
  emailPlaceholder,
  messagePlaceholder,
  submitLabel,
  onSubmit,
}: ContactFormProps & NodeProps) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const canSubmit = name.trim() !== "" && email.trim() !== "" && message.trim() !== "";

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    onSubmit({ name, email, message });
    setName("");
    setEmail("");
    setMessage("");
  }

  return (
    <section data-node-id={nodeId} className="bg-(--color-semantic-bg) py-(--space-16)">
      <Container className="max-w-[36rem]">
        <div className="mb-(--space-10) flex flex-col gap-(--space-2)">
          <Heading nodeId="support.contact-form.heading" level={2} variant="section">
            {heading}
          </Heading>
          <Text nodeId="support.contact-form.description" variant="lead" className="text-(--color-semantic-textMuted)">
            {description}
          </Text>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="flex flex-col gap-(--space-4)">
            <Input nodeId="support.contact-form.name-field" placeholder={namePlaceholder} value={name} onChange={setName} />
            <Input nodeId="support.contact-form.email-field" type="email" placeholder={emailPlaceholder} value={email} onChange={setEmail} />
            <Textarea nodeId="support.contact-form.message-field" placeholder={messagePlaceholder} rows={5} value={message} onChange={setMessage} />
            <Button nodeId="support.contact-form.submit" variant="primary" type="submit" disabled={!canSubmit}>
              {submitLabel}
            </Button>
          </div>
        </form>
      </Container>
    </section>
  );
}
