#!/bin/bash
# Create today's daily note from template if it doesn't exist

VAULT_PATH="C:/Users/Jay/Documents/Notes/Braindump"
TEMPLATE_PATH="$VAULT_PATH/00-SYSTEM/Templates/Daily Note.md"
DAILY_PATH="$VAULT_PATH/10-DAILY"

TODAY=$(date +%Y-%m-%d)
DAILY_NOTE="$DAILY_PATH/$TODAY.md"

if [ ! -f "$DAILY_NOTE" ]; then
    echo "Creating daily note for $TODAY..."

    # Copy template
    if [ -f "$TEMPLATE_PATH" ]; then
        cp "$TEMPLATE_PATH" "$DAILY_NOTE"
        echo "✅ Created daily note: $DAILY_NOTE"
    else
        echo "❌ Template not found at: $TEMPLATE_PATH"
        exit 1
    fi
else
    echo "Daily note already exists: $DAILY_NOTE"
fi

echo "$DAILY_NOTE"
