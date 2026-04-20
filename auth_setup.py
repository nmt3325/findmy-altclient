#!/usr/bin/env python3
"""
Interactive Apple account setup for FindMy Location Tracker.
Run this script once before starting the server.
"""

from __future__ import annotations

import sys
from pathlib import Path

DATA_DIR = Path(__file__).parent / "data"
ACCOUNT_PATH = DATA_DIR / "account.json"
ANISETTE_LIBS_PATH = DATA_DIR / "ani_libs.bin"

# Set to your anisette server URL if you have one, or leave None for built-in
ANISETTE_SERVER = None


def main() -> int:
    try:
        from findmy import (
            AppleAccount,
            LocalAnisetteProvider,
            LoginState,
            RemoteAnisetteProvider,
            SmsSecondFactorMethod,
            TrustedDeviceSecondFactorMethod,
        )
    except ImportError:
        print("ERROR: findmy package not installed.")
        print("Run: pip install findmy")
        return 1

    DATA_DIR.mkdir(exist_ok=True)

    if ACCOUNT_PATH.exists():
        answer = input(f"Account already exists at {ACCOUNT_PATH}. Re-authenticate? [y/N] ").strip().lower()
        if answer != "y":
            print("Skipping. Existing account kept.")
            return 0

    print("=== FindMy Location Tracker – Apple Account Setup ===")
    print()

    ani = (
        RemoteAnisetteProvider(ANISETTE_SERVER)
        if ANISETTE_SERVER
        else LocalAnisetteProvider(libs_path=str(ANISETTE_LIBS_PATH))
    )

    acc = AppleAccount(ani)

    email = input("Apple ID (email): ").strip()
    password = input("Password: ").strip()

    print("\nLogging in…")
    state = acc.login(email, password)

    if state == LoginState.REQUIRE_2FA:
        print("\nTwo-factor authentication required.")
        methods = acc.get_2fa_methods()
        for i, method in enumerate(methods):
            if isinstance(method, TrustedDeviceSecondFactorMethod):
                print(f"  {i}: Trusted Device")
            elif isinstance(method, SmsSecondFactorMethod):
                print(f"  {i}: SMS to {method.phone_number}")

        idx = int(input("Select method number: ").strip())
        method = methods[idx]
        method.request()
        code = input("Enter verification code: ").strip()
        method.submit(code)
        print("2FA completed.")

    acc.to_json(str(ACCOUNT_PATH))
    print(f"\nAccount saved to {ACCOUNT_PATH}")
    print(f"Logged in as: {acc.account_name} ({acc.first_name} {acc.last_name})")
    print("\nSetup complete. You can now start the server with: python server.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
