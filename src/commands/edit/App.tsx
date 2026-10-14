import React, { useState, useEffect, useMemo } from 'react';
import { Box, Text, useInput, useApp, useStdout } from 'ink';
import { DisplayMessage, MarkType, RawMessage, Turn } from './types.js';
import {
  loadSession,
  saveSession,
  createBackup,
  toDisplayMessages,
  toTurns,
  formatSize,
  compactMessage,
  removeMessages,
} from './session.js';
import { compactMessagesProgressive } from '../../utils/compact.js';
import { ClaudeOrchestrator } from '../../services/orchestrator.js';
import { summarizeText } from '../../utils/summary-provider.js';

type ViewMode = 'messages' | 'turns';

interface Props {
  sessionId: string;
  filePath: string;
}

export default function App({ sessionId, filePath }: Props) {
  const { exit } = useApp();
  const { stdout } = useStdout();

  // Dynamic visible rows based on terminal height
  // Reserve space for header, footer, status, and padding
  const visibleRows = Math.max(5, (stdout?.rows || 40) - 18);
  const [rawMessages, setRawMessages] = useState<RawMessage[]>([]);
  const [displayMessages, setDisplayMessages] = useState<DisplayMessage[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [viewMode, setViewMode] = useState<ViewMode>('messages');
  const [marks, setMarks] = useState<Map<number, MarkType>>(new Map()); // keys are raw indexes
  const [cursor, setCursor] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [status, setStatus] = useState('');
  const [viewingMessage, setViewingMessage] = useState<DisplayMessage | null>(null);

  // Load session on mount
  useEffect(() => {
    const raw = loadSession(filePath);
    setRawMessages(raw);
    setDisplayMessages(toDisplayMessages(raw));
    setTurns(toTurns(raw));
  }, [filePath]);

  // Calculate sizes
  const originalSize = rawMessages.reduce((sum, m) => sum + JSON.stringify(m).length, 0);
  const newSize = calculateNewSize();

  // Calculate top 10% threshold for size warnings and get sorted large message indexes
  const { sizeThreshold, largeMessageIndexes } = useMemo(() => {
    if (displayMessages.length === 0) return { sizeThreshold: Infinity, largeMessageIndexes: [] as number[] };
    const withIndex = displayMessages.map((m, i) => ({ size: m.size, index: i }));
    const sorted = [...withIndex].sort((a, b) => b.size - a.size);
    const top10Count = Math.max(1, Math.floor(sorted.length * 0.1));
    const top10 = sorted.slice(0, top10Count);
    const threshold = top10[top10.length - 1]?.size || Infinity;
    // Sort by index for navigation order
    const indexes = top10.map(t => t.index).sort((a, b) => a - b);
    return { sizeThreshold: threshold, largeMessageIndexes: indexes };
  }, [displayMessages]);

  // Calculate cumulative sizes for percentage position
  const cumulativeSizes = useMemo(() => {
    let cumulative = 0;
    return displayMessages.map(m => {
      cumulative += m.size;
      return cumulative;
    });
  }, [displayMessages]);

  // Get percentage position based on bytes
  const positionPercent = useMemo(() => {
    if (cumulativeSizes.length === 0) return 0;
    const totalSize = cumulativeSizes[cumulativeSizes.length - 1] || 1;
    const currentPos = cursor > 0 ? cumulativeSizes[cursor - 1] : 0;
    return Math.round((currentPos / totalSize) * 100);
  }, [cursor, cumulativeSizes]);

  function calculateNewSize(): number {
    let size = 0;
    const toRemove = new Set<number>();
    const toCompact = new Set<number>();

    for (const [idx, mark] of marks) {
      const dm = displayMessages[idx];
      if (!dm) continue;

      if (mark === 'delete') {
        toRemove.add(dm.rawIndex);
        if (dm.relatedRawIndexes) {
          dm.relatedRawIndexes.forEach(ri => toRemove.add(ri));
        }
      } else if (mark === 'compact') {
        toCompact.add(dm.rawIndex);
        if (dm.relatedRawIndexes) {
          dm.relatedRawIndexes.forEach(ri => toCompact.add(ri));
        }
      }
    }

    rawMessages.forEach((msg, i) => {
      if (toRemove.has(i)) return;
      if (toCompact.has(i)) {
        size += JSON.stringify(compactMessage(msg)).length;
      } else {
        size += JSON.stringify(msg).length;
      }
    });

    return size;
  }

  // Handle keyboard input
  useInput((input, key) => {
    if (viewingMessage) {
      // Any key exits view mode
      setViewingMessage(null);
      return;
    }

    if (key.pageDown) {
      // Loop through largest messages by size (descending)
      const sortedBySize = [...largeMessageIndexes].sort((a, b) =>
        displayMessages[b].size - displayMessages[a].size
      );
      const currentRank = sortedBySize.indexOf(cursor);
      const nextRank = currentRank === -1 ? 0 : Math.min(currentRank + 1, sortedBySize.length - 1);
      const next = sortedBySize[nextRank];
      if (next !== undefined) {
        setCursor(next);
        if (next < scrollOffset) setScrollOffset(Math.max(0, next - 2));
        if (next >= scrollOffset + visibleRows) setScrollOffset(next - 2);
      }
    } else if (key.pageUp) {
      // Loop through largest messages by size (ascending back)
      const sortedBySize = [...largeMessageIndexes].sort((a, b) =>
        displayMessages[b].size - displayMessages[a].size
      );
      const currentRank = sortedBySize.indexOf(cursor);
      if (currentRank > 0) {
        const prev = sortedBySize[currentRank - 1];
        setCursor(prev);
        if (prev < scrollOffset) setScrollOffset(Math.max(0, prev - 2));
        if (prev >= scrollOffset + visibleRows) setScrollOffset(prev - 2);
      }
    } else if (key.upArrow && key.ctrl) {
      // Jump to previous large message (by position)
      const prev = largeMessageIndexes.filter(i => i < cursor).pop();
      if (prev !== undefined) {
        setCursor(prev);
        if (prev < scrollOffset) {
          setScrollOffset(Math.max(0, prev - 2));
        }
      }
    } else if (key.downArrow && key.ctrl) {
      // Jump to next large message (by position)
      const next = largeMessageIndexes.find(i => i > cursor);
      if (next !== undefined) {
        setCursor(next);
        if (next >= scrollOffset + visibleRows) {
          setScrollOffset(next - 2);
        }
      }
    } else if (key.upArrow) {
      setCursor(c => Math.max(0, c - 1));
      if (cursor - 1 < scrollOffset) {
        setScrollOffset(s => Math.max(0, s - 1));
      }
    } else if (key.downArrow) {
      const maxIdx = viewMode === 'turns' ? turns.length - 1 : displayMessages.length - 1;
      setCursor(c => Math.min(maxIdx, c + 1));
      if (cursor + 1 >= scrollOffset + visibleRows) {
        setScrollOffset(s => s + 1);
      }
    }
    if (input === 'c') {
      // Toggle compact
      const newMarks = new Map(marks);
      if (viewMode === 'turns') {
        const turn = turns[cursor];
        if (turn) {
          const allCompact = turn.rawIndexes.every(ri => newMarks.get(ri) === 'compact');
          turn.rawIndexes.forEach(ri => allCompact ? newMarks.delete(ri) : newMarks.set(ri, 'compact'));
        }
      } else {
        const dm = displayMessages[cursor];
        const idx = dm?.rawIndex ?? cursor;
        newMarks.get(idx) === 'compact' ? newMarks.delete(idx) : newMarks.set(idx, 'compact');
      }
      setMarks(newMarks);
    }
    if (input === 'd') {
      // Toggle delete
      const newMarks = new Map(marks);
      if (viewMode === 'turns') {
        const turn = turns[cursor];
        if (turn) {
          const allDelete = turn.rawIndexes.every(ri => newMarks.get(ri) === 'delete');
          turn.rawIndexes.forEach(ri => allDelete ? newMarks.delete(ri) : newMarks.set(ri, 'delete'));
        }
      } else {
        const dm = displayMessages[cursor];
        const idx = dm?.rawIndex ?? cursor;
        newMarks.get(idx) === 'delete' ? newMarks.delete(idx) : newMarks.set(idx, 'delete');
      }
      setMarks(newMarks);
    }
    if (input === 's') {
      // Toggle summarize
      const newMarks = new Map(marks);
      if (viewMode === 'turns') {
        const turn = turns[cursor];
        if (turn) {
          const allSummarize = turn.rawIndexes.every(ri => newMarks.get(ri) === 'summarize');
          turn.rawIndexes.forEach(ri => allSummarize ? newMarks.delete(ri) : newMarks.set(ri, 'summarize'));
        }
      } else {
        const dm = displayMessages[cursor];
        const idx = dm?.rawIndex ?? cursor;
        newMarks.get(idx) === 'summarize' ? newMarks.delete(idx) : newMarks.set(idx, 'summarize');
      }
      setMarks(newMarks);
    }
    if (input === 'u') {
      // Undo mark on current item
      const newMarks = new Map(marks);
      if (viewMode === 'turns') {
        const turn = turns[cursor];
        if (turn) turn.rawIndexes.forEach(ri => newMarks.delete(ri));
      } else {
        newMarks.delete(cursor);
      }
      setMarks(newMarks);
    }
    if (input === 't') {
      // Toggle view mode
      setViewMode(vm => vm === 'messages' ? 'turns' : 'messages');
      setCursor(0);
      setScrollOffset(0);
      setStatus(viewMode === 'messages' ? 'Switched to turns view' : 'Switched to messages view');
    }
    if (input === 'v') {
      // View message (only in messages mode)
      if (viewMode === 'messages') {
        setViewingMessage(displayMessages[cursor]);
      }
    }
    if (key.return) {
      // Apply changes
      void applyChanges();
    }
    if (input === 'f') {
      // Fork
      void applyChanges(true);
    }
    if (input === 'q') {
      exit();
    }
    if (input === 'p') {
      // Progressive compact - aggressive truncation targeting 40% size
      applyProgressiveCompact();
    }
  });

  async function applyChanges(fork = false) {
    if (marks.size === 0) {
      setStatus('No changes to apply');
      return;
    }

    // Create backup
    const backupPath = createBackup(filePath);
    setStatus(`Backup: ${backupPath.split(/[/\\]/).pop()}`);

    // Collect indexes to remove/compact/summarize
    const toRemove = new Set<number>();
    const toCompact = new Set<number>();
    const toSummarize: number[] = [];

    for (const [idx, mark] of marks) {
      const dm = displayMessages[idx];
      if (!dm) continue;

      if (mark === 'delete') {
        toRemove.add(dm.rawIndex);
        if (dm.relatedRawIndexes) {
          dm.relatedRawIndexes.forEach(ri => toRemove.add(ri));
        }
      } else if (mark === 'compact') {
        toCompact.add(dm.rawIndex);
        if (dm.relatedRawIndexes) {
          dm.relatedRawIndexes.forEach(ri => toCompact.add(ri));
        }
      } else if (mark === 'summarize') {
        toSummarize.push(dm.rawIndex);
        if (dm.relatedRawIndexes) {
          dm.relatedRawIndexes.forEach(ri => toSummarize.push(ri));
        }
      }
    }

    // Handle summarization if any messages are marked
    let summaryMessage: RawMessage | null = null;
    let summaryInsertIndex = -1;
    if (toSummarize.length > 0) {
      setStatus('Summarizing...');

      // Sort indexes and find insertion point (first summarized message position)
      const sortedIndexes = [...new Set(toSummarize)].sort((a, b) => a - b);
      summaryInsertIndex = sortedIndexes[0];

      // Extract content from messages to summarize
      const contentParts: string[] = [];
      for (const idx of sortedIndexes) {
        const msg = rawMessages[idx];
        const content = extractMessageContent(msg);
        if (content) {
          contentParts.push(content);
        }
        // Mark for removal
        toRemove.add(idx);
      }

      // Call Claude to summarize
      if (contentParts.length > 0) {
        const combinedContent = contentParts.join('\n\n---\n\n');
        try {
          const summaryResult = await summarizeText(
            combinedContent,
            'Summarize this conversation segment concisely. Focus on what was done and key outcomes. Be brief (2-5 sentences).',
            {
              cwd: process.cwd(),
              timeoutMs: 300_000,
            }
          );
          const summary = summaryResult.text;

          // Create summary as a proper user message that Claude API understands
          // Format: <context-summary> tag so Claude knows this is compacted context
          const templateMsg = rawMessages[summaryInsertIndex];
          summaryMessage = {
            type: 'user',
            sessionId: templateMsg.sessionId,
            parentUuid: templateMsg.parentUuid,
            uuid: `summary-${Date.now()}`,
            timestamp: new Date().toISOString(),
            message: {
              role: 'user',
              content: `<context-summary>\nThe following is a summary of previous conversation that was compacted to save context:\n\n${summary}\n</context-summary>`,
            },
          };
          if (summaryResult.fallbackFrom) {
            setStatus(`Summarized with ${summaryResult.providerUsed} (fallback from ${summaryResult.fallbackFrom})`);
          }
        } catch (err) {
          setStatus(`Summarization failed: ${err}`);
          return;
        }
      }
    }

    // Apply compaction
    let result = rawMessages.map((msg, i) => {
      if (toCompact.has(i)) {
        return compactMessage(msg);
      }
      return msg;
    });

    // Remove messages (including summarized ones)
    result = removeMessages(result, toRemove);

    // Insert summary message at the right position
    if (summaryMessage && summaryInsertIndex >= 0) {
      // Calculate new index after removals
      let newIndex = 0;
      for (let i = 0; i < summaryInsertIndex; i++) {
        if (!toRemove.has(i)) newIndex++;
      }
      result.splice(newIndex, 0, summaryMessage);
    }

    // Save
    saveSession(filePath, result);

    // Calculate actual savings
    const newTotalSize = result.reduce((sum, m) => sum + JSON.stringify(m).length, 0);
    const savedBytes = originalSize - newTotalSize;

    const summarizedCount = toSummarize.length > 0 ? `, ${new Set(toSummarize).size} summarized` : '';
    setStatus(`Saved! ${formatSize(savedBytes)} reduced (${Math.round(savedBytes / originalSize * 100)}%)${summarizedCount}`);

    if (fork) {
      // Spawn forked session
      const orchestrator = new ClaudeOrchestrator();
      const commandLine = `cmd.exe /K claude --resume ${sessionId} --fork-session`;
      orchestrator.spawnTaskWithCommand(commandLine, {
        name: `Edited ${sessionId.slice(0, 8)}`,
        workingDir: process.cwd(),
      });
      setStatus('Forked!');
      setTimeout(() => exit(), 1000);
    }
  }

  function applyProgressiveCompact(fork = false) {
    // Create backup
    const backupPath = createBackup(filePath);

    // Apply progressive compaction targeting 40% of original size
    const compactResult = compactMessagesProgressive(rawMessages as Record<string, unknown>[], {
      targetRatio: 0.40,
      cutoffPercent: 50,
      minChars: 20,
      maxChars: 200,
    });

    // Save
    saveSession(filePath, compactResult.messages as RawMessage[]);

    // Calculate savings
    const savedBytes = compactResult.originalSize - compactResult.compactedSize;
    const reductionPercent = Math.round((savedBytes / compactResult.originalSize) * 100);
    const finalPercent = Math.round((compactResult.compactedSize / compactResult.originalSize) * 100);

    setStatus(`Progressive compact: ${formatSize(compactResult.originalSize)} → ${formatSize(compactResult.compactedSize)} (${finalPercent}% of original, ${compactResult.stats.truncated} truncated)`);

    // Reload session to reflect changes
    const reloaded = loadSession(filePath);
    setRawMessages(reloaded);
    setDisplayMessages(toDisplayMessages(reloaded));
    setTurns(toTurns(reloaded));
    setMarks(new Map());

    if (fork) {
      const orchestrator = new ClaudeOrchestrator();
      const commandLine = `cmd.exe /K claude --resume ${sessionId} --fork-session`;
      orchestrator.spawnTaskWithCommand(commandLine, {
        name: `Compacted ${sessionId.slice(0, 8)}`,
        workingDir: process.cwd(),
      });
      setStatus('Forked!');
      setTimeout(() => exit(), 1000);
    }
  }

  // Helper to extract readable content from a message
  function extractMessageContent(msg: RawMessage): string | null {
    const parts: string[] = [];

    // User/assistant text content
    if (msg.message?.content) {
      if (typeof msg.message.content === 'string') {
        parts.push(`[User]: ${msg.message.content}`);
      } else if (Array.isArray(msg.message.content)) {
        for (const block of msg.message.content) {
          if ((block as any).type === 'text' && (block as any).text) {
            const role = msg.type === 'assistant' ? 'Assistant' : 'User';
            parts.push(`[${role}]: ${(block as any).text}`);
          }
          if ((block as any).type === 'tool_use' && (block as any).name) {
            parts.push(`[Tool call]: ${(block as any).name}`);
          }
          if ((block as any).type === 'tool_result') {
            const content = (block as any).content;
            if (typeof content === 'string') {
              parts.push(`[Tool result]: ${content.slice(0, 500)}`);
            }
          }
        }
      }
    }

    // Tool use result
    if (msg.toolUseResult) {
      if (msg.toolUseResult.stdout) {
        parts.push(`[Output]: ${msg.toolUseResult.stdout.slice(0, 500)}`);
      }
      if (msg.toolUseResult.file?.content) {
        parts.push(`[File]: ${msg.toolUseResult.file.filePath}`);
      }
    }

    return parts.length > 0 ? parts.join('\n') : null;
  }

  // View mode
  if (viewingMessage) {
    const raw = rawMessages[viewingMessage.rawIndex];
    let content = '';

    // Extract the actual content based on message type
    if (viewingMessage.type === 'tool' || viewingMessage.type === 'user') {
      // Get tool result content
      if (raw.message?.content && Array.isArray(raw.message.content)) {
        for (const block of raw.message.content) {
          if ((block as any).type === 'tool_result') {
            const resultContent = (block as any).content;
            if (typeof resultContent === 'string') {
              content = resultContent;
            } else if (Array.isArray(resultContent)) {
              content = resultContent.map((r: any) => r.text || '').join('\n');
            }
            break;
          }
        }
      }
      // Fallback to toolUseResult
      if (!content && raw.toolUseResult) {
        if (raw.toolUseResult.stdout) content = raw.toolUseResult.stdout;
        else if (raw.toolUseResult.file?.content) content = raw.toolUseResult.file.content;
        // Write tool stores content directly in toolUseResult.content
        else if (typeof (raw.toolUseResult as any).content === 'string') {
          content = (raw.toolUseResult as any).content;
        }
      }
    } else if (viewingMessage.type === 'assistant') {
      // Get assistant text
      if (raw.message?.content && Array.isArray(raw.message.content)) {
        for (const block of raw.message.content) {
          if ((block as any).type === 'text' && (block as any).text) {
            content = (block as any).text;
            break;
          }
        }
      }
    } else if (viewingMessage.type === 'thinking') {
      // Get thinking content
      if (raw.message?.content && Array.isArray(raw.message.content)) {
        for (const block of raw.message.content) {
          if ((block as any).type === 'thinking' && (block as any).thinking) {
            content = (block as any).thinking;
            break;
          }
        }
      }
    }

    // Fallback to user message text
    if (!content && raw.message?.content && typeof raw.message.content === 'string') {
      content = raw.message.content;
    }

    if (!content) {
      content = JSON.stringify(raw, null, 2);
    }

    const label = viewingMessage.toolName
      ? `[${viewingMessage.toolName}]`
      : `[${viewingMessage.type}]`;

    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>Message {viewingMessage.index + 1} {label}</Text>
        <Text dimColor>Size: {formatSize(viewingMessage.size)} | Press any key to close</Text>
        <Box marginTop={1}>
          <Text>{content.slice(0, 3000)}{content.length > 3000 ? '\n\n...[truncated]' : ''}</Text>
        </Box>
      </Box>
    );
  }

  // Get mark for a turn (based on its raw indexes)
  function getTurnMark(turn: Turn): MarkType {
    const turnMarks = turn.rawIndexes.map(ri => marks.get(ri)).filter(Boolean);
    if (turnMarks.length === 0) return null;
    // If all have same mark, return it
    if (turnMarks.every(m => m === 'compact')) return 'compact';
    if (turnMarks.every(m => m === 'delete')) return 'delete';
    if (turnMarks.every(m => m === 'summarize')) return 'summarize';
    return 'compact'; // Mixed marks show as compact
  }

  // Main view
  const visibleItems = viewMode === 'turns'
    ? turns.slice(scrollOffset, scrollOffset + visibleRows)
    : displayMessages.slice(scrollOffset, scrollOffset + visibleRows);
  const totalItems = viewMode === 'turns' ? turns.length : displayMessages.length;

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box borderStyle="single" paddingX={1}>
        <Text bold>Session Editor</Text>
        <Text dimColor> [{viewMode}]</Text>
        <Text> - </Text>
        <Text dimColor>{sessionId.slice(0, 8)}...</Text>
        <Text> (</Text>
        <Text>{formatSize(originalSize)}</Text>
        {marks.size > 0 && (
          <>
            <Text> → </Text>
            <Text color="green">{formatSize(newSize)}</Text>
            <Text color="green"> (-{Math.round((originalSize - newSize) / originalSize * 100)}%)</Text>
            <Text dimColor> | {marks.size} marked</Text>
          </>
        )}
        <Text>)</Text>
      </Box>

      {/* Message/Turn list */}
      <Box flexDirection="column" marginY={1}>
        {viewMode === 'messages' ? (
          // Messages view
          (visibleItems as DisplayMessage[]).map((msg, i) => {
            const actualIndex = scrollOffset + i;
            const isSelected = actualIndex === cursor;
            const mark = marks.get(msg.rawIndex);

            let icon = '◯';
            let bgColor: string | undefined;
            let textColor: string | undefined;

            if (mark === 'compact') {
              icon = '◉';
              bgColor = 'yellow';
            } else if (mark === 'delete') {
              icon = '✗';
              bgColor = 'red';
              textColor = 'white';
            } else if (mark === 'summarize') {
              icon = 'Σ';
              bgColor = 'blue';
              textColor = 'white';
            }

            const typeLabel = msg.toolName ? `[${msg.toolName}]` : `[${msg.type}]`;
            const sizeWarning = msg.size >= sizeThreshold ? ' ⚠️' : '';

            // Calculate percentage position for this message
            const totalSize = cumulativeSizes[cumulativeSizes.length - 1] || 1;
            const msgPercent = Math.round((cumulativeSizes[actualIndex] / totalSize) * 100);

            return (
              <Box key={`${msg.uuid}-${actualIndex}`}>
                <Text
                  inverse={isSelected}
                  backgroundColor={bgColor}
                  color={textColor}
                  strikethrough={mark === 'delete'}
                >
                  {` ${icon} ${String(actualIndex + 1).padStart(3)}. ${typeLabel.padEnd(12)} ${msg.preview.slice(0, 55).padEnd(55)} ${formatSize(msg.size).padStart(8)}${sizeWarning} `}
                </Text>
                <Text dimColor>{`[${String(msgPercent).padStart(2)}%]`}</Text>
              </Box>
            );
          })
        ) : (
          // Turns view
          (visibleItems as Turn[]).map((turn, i) => {
            const actualIndex = scrollOffset + i;
            const isSelected = actualIndex === cursor;
            const mark = getTurnMark(turn);

            let icon = '◯';
            let bgColor: string | undefined;
            let textColor: string | undefined;

            if (mark === 'compact') {
              icon = '◉';
              bgColor = 'yellow';
            } else if (mark === 'delete') {
              icon = '✗';
              bgColor = 'red';
              textColor = 'white';
            } else if (mark === 'summarize') {
              icon = 'Σ';
              bgColor = 'blue';
              textColor = 'white';
            }

            return (
              <Box key={`turn-${turn.index}`}>
                <Text
                  inverse={isSelected}
                  backgroundColor={bgColor}
                  color={textColor}
                  strikethrough={mark === 'delete'}
                >
                  {` ${icon} ${String(actualIndex + 1).padStart(3)}. ${turn.userPrompt.slice(0, 40).padEnd(40)} ${String(turn.messageCount).padStart(3)} msgs ${formatSize(turn.size).padStart(8)} `}
                </Text>
                <Text dimColor>{turn.preview.slice(0, 30)}</Text>
              </Box>
            );
          })
        )}
      </Box>

      {/* Scroll indicator */}
      {totalItems > visibleRows && (
        <Text dimColor>
          Showing {scrollOffset + 1}-{Math.min(scrollOffset + visibleRows, totalItems)} of {totalItems} {viewMode}
        </Text>
      )}

      {/* Footer */}
      <Box borderStyle="single" paddingX={1} marginTop={1}>
        <Text>
          <Text bold>[↑↓]</Text> Nav{' '}
          <Text bold>[c]</Text> Compact{' '}
          <Text bold>[d]</Text> Del{' '}
          <Text bold>[p]</Text> Prog40%{' '}
          <Text bold>[v]</Text> View{' '}
          <Text bold>[u]</Text> Undo{' '}
          <Text bold>[Enter]</Text> Apply{' '}
          <Text bold>[f]</Text> Fork{' '}
          <Text bold>[q]</Text> Quit
        </Text>
      </Box>

      {/* Status */}
      {status && (
        <Box marginTop={1}>
          <Text color="cyan">{status}</Text>
        </Box>
      )}
    </Box>
  );
}
