"""Bounded provider interface; implementations never grant execution authority."""
from typing import Protocol

from .contracts import AccountView, ActionKind, ModelRun, ProviderStatus


class AdvisoryProvider(Protocol):
    def status(self) -> ProviderStatus: ...

    def discover(self) -> ProviderStatus: ...

    def analyze(self, view: AccountView) -> ModelRun: ...

    def draft(self, view: AccountView, action_kind: ActionKind) -> ModelRun: ...
