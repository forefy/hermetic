"""A real Hermes session store for a test, written through Hermes' storage interface the way Hermes writes one."""
from pathlib import Path


def writer(path):
    """A writing handle on the store at ``path`` (a state.db, made if missing), as Hermes holds one; close it after."""
    from persistence_assembly import open_persistence, profile_scope
    return open_persistence(profile_scope(home=Path(path).parent), eager=True)


def add_chat(store, sid, msgs, model="z-ai/glm-5.3", source="desktop"):
    """A chat ``sid`` holding ``msgs`` (live message dicts), appended as Hermes appends a turn."""
    from persistence.conversation.sessions import NewSession
    store.sessions.create(NewSession(session_id=sid, source=source, model=model))
    add_messages(store, sid, msgs)


def add_messages(store, sid, msgs):
    from persistence.conversation.messages import NewMessage
    if msgs:
        store.messages.append_batch(sid, [NewMessage.from_live(m) for m in msgs])
