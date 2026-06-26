-- Add persisted clarify candidates to conversation assistant messages.

ALTER TABLE public.conversation_message
  ADD COLUMN clarify_candidates_json JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.conversation_message
  ADD CONSTRAINT conversation_message_clarify_candidates_is_array
  CHECK (jsonb_typeof(clarify_candidates_json) = 'array');
