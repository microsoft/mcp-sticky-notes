import express, { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolResult, isInitializeRequest, PrimitiveSchemaDefinition, ReadResourceResult, ResourceLink } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { TableClient, AzureNamedKeyCredential, odata } from '@azure/data-tables';
import { DefaultAzureCredential } from '@azure/identity';
import { createCanvas } from 'canvas';

// Configuration for transport type
type TransportType = 'http' | 'stdio';
const TRANSPORT_TYPE: TransportType = (process.env.TRANSPORT_TYPE as TransportType) || 'http';

// When running in stdio mode, ensure any regular logging does not write to stdout
// (stdout is reserved for MCP protocol messages). Redirect console.log/info to
// stderr so human logs appear on stderr and the MCP JSON stream on stdout stays clean.
if (TRANSPORT_TYPE === 'stdio') {
  const originalLog = console.log;
  console.log = (...args: any[]) => {
    try {
      console.error(...args);
    } catch (e) {
      // Fallback to original if something goes wrong
      originalLog(...args);
    }
  };
  console.info = (...args: any[]) => {
    try {
      console.error(...args);
    } catch (e) {
      originalLog(...args);
    }
  };
}

// Azure Table Storage configuration
const AZURE_STORAGE_ACCOUNT = process.env.AZURE_STORAGE_ACCOUNT || 'defaultstorageaccount';
const AZURE_STORAGE_KEY = process.env.AZURE_STORAGE_KEY || ''; // Keep as backup fallback
const NOTES_TABLE_NAME = 'StickyNotesData';
const DEFAULT_NOTE_KEY = 'default';

// Initialize Azure Table Storage client
let tableClient: TableClient | null = null;

const initializeAzureStorage = async (): Promise<TableClient | null> => {
  if (tableClient) {
    return tableClient;
  }

  try {
    // Try Managed Identity first (preferred method)
    console.log('🔐 Attempting authentication with Managed Identity...');
    const credential = new DefaultAzureCredential();
    tableClient = new TableClient(`https://${AZURE_STORAGE_ACCOUNT}.table.core.windows.net`, NOTES_TABLE_NAME, credential);

    // Test the connection by trying to create table
    await tableClient.createTable();
    console.log('✅ Successfully authenticated with Managed Identity');
    return tableClient;
  } catch (managedIdentityError) {
    console.log('⚠️ Managed Identity authentication failed, trying storage key fallback...');
    console.log('Managed Identity error:', managedIdentityError instanceof Error ? managedIdentityError.message : String(managedIdentityError));
    
    // Fallback to storage key authentication
    if (AZURE_STORAGE_KEY) {
      try {
        console.log('🔑 Attempting authentication with Storage Key...');
        const keyCredential = new AzureNamedKeyCredential(AZURE_STORAGE_ACCOUNT, AZURE_STORAGE_KEY);
        tableClient = new TableClient(`https://${AZURE_STORAGE_ACCOUNT}.table.core.windows.net`, NOTES_TABLE_NAME, keyCredential);
        
        // Test the connection
        await tableClient.createTable();
        console.log('✅ Successfully authenticated with Storage Key (fallback)');
        return tableClient;
      } catch (keyError) {
        console.log('❌ Storage Key authentication also failed');
        console.log('Storage Key error:', keyError instanceof Error ? keyError.message : String(keyError));
      }
    } else {
      console.log('🔑 No storage key available for fallback');
    }
    
    // Fallback to in-memory storage if both Azure methods fail
    console.log('📝 Azure Table Storage not available, using in-memory storage');
    return null;
  }
};

// In-memory fallback storage - now organized by user partition and logical key; each key holds an array of notes
const memoryNotes: { [partitionKey: string]: { [noteKey: string]: Array<{ id: string; text: string; timestamp: Date; }> } } = {};
 
// Sticky note storage interface
interface StickyNoteEntity {
  partitionKey: string;
  rowKey: string; // unique id for this particular note entity
  noteKey?: string; // logical grouping key (e.g. "default", "private")
  text: string; // the note text
  timestamp: Date | string; // created at
  etag?: string;
}

// Get note color based on key name (returns hex color code for image generation)
const getNoteColorHex = (key: string): { bg: string; text: string; emoji: string } => {
  const lowerKey = key.toLowerCase();
  
  if (lowerKey.includes('personal') || lowerKey.includes('private') || lowerKey === 'me') {
    return { bg: '#FFE066', text: '#8B4513', emoji: '🟡' }; // Bright Yellow
  }
  if (lowerKey.includes('work') || lowerKey.includes('job') || lowerKey.includes('office') || 
      lowerKey.includes('meeting') || lowerKey.includes('project')) {
    return { bg: '#90EE90', text: '#006400', emoji: '🟢' }; // Bright Green
  }
  if (lowerKey.includes('idea') || lowerKey.includes('brainstorm') || lowerKey.includes('creative') || 
      lowerKey.includes('thought')) {
    return { bg: '#87CEEB', text: '#191970', emoji: '🔵' }; // Sky Blue
  }
  if (lowerKey.includes('quote') || lowerKey.includes('inspiration') || lowerKey.includes('wisdom')) {
    return { bg: '#DDA0DD', text: '#4B0082', emoji: '🟣' }; // Plum Purple
  }
  if (lowerKey.includes('remind') || lowerKey.includes('todo') || lowerKey.includes('task') || 
      lowerKey.includes('alert')) {
    return { bg: '#FFA500', text: '#8B0000', emoji: '🟠' }; // Bright Orange
  }
  
  return { bg: '#F0F8FF', text: '#2F4F4F', emoji: '⚪' }; // Light Blue/Gray (default)
};

// Get note color based on key name
const getNoteColor = (key: string): string => {
  return getNoteColorHex(key).emoji;
};

// Split text into lines with proper newline and word wrapping
const splitTextIntoLines = (text: string, ctx: any, maxWidth: number, maxLines: number): string[] => {
  // First split by newlines to handle multi-line input properly
  const textLines = text.split(/\r?\n/);
  const lines: string[] = [];
  
  for (const textLine of textLines) {
    if (lines.length >= maxLines) break; // Max lines limit
    
    if (!textLine.trim()) {
      // Handle empty lines
      lines.push('');
      continue;
    }
    
    // Split this line by words and wrap if needed
    const words = textLine.split(' ');
    let currentLine = '';
    
    for (const word of words) {
      const testLine = currentLine ? currentLine + ' ' + word : word;
      const metrics = ctx.measureText(testLine);
      
      if (metrics.width > maxWidth && currentLine) {
        lines.push(currentLine);
        currentLine = word;
        if (lines.length >= maxLines) break; // Max lines limit
      } else {
        currentLine = testLine;
      }
    }
    if (currentLine && lines.length < maxLines) {
      lines.push(currentLine);
    }
  }
  
  return lines;
};

// Calculate maximum lines that fit in available vertical space
const calculateMaxLines = (canvasHeight: number, startY: number, endY: number, lineHeight: number): number => {
  const availableHeight = endY - startY;
  return Math.floor(availableHeight / lineHeight);
};



// Generate a sticky note image using Canvas to create PNG (Azure-compatible with fontconfig fix)
const generateStickyNoteImage = async (key: string, text: string, timestamp: Date): Promise<string> => {
  try {
    console.log(`🖼️ Starting PNG image generation for key: ${key}, text length: ${text.length}`);
    
    const colors = getNoteColorHex(key);
    console.log(`🎨 Colors selected: ${JSON.stringify(colors)}`);
    
    const width = 300;
    const height = 300;
    
    // Create canvas with enhanced error handling for Azure environments
    let canvas;
    let ctx;
    try {
      canvas = createCanvas(width, height);
      ctx = canvas.getContext('2d');
      console.log(`✅ Canvas created successfully`);
    } catch (canvasError) {
      console.error('❌ Canvas creation failed:', canvasError);
      return ''; // Return empty string to fall back to text-only
    }
    
    // Draw shadow with stronger effect for colored backgrounds
    ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
    ctx.fillRect(6, 6, width - 6, height - 6);
    
    // Draw note background with color
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, width - 6, height - 6);
    
    // Draw border with color-coordinated border
    ctx.strokeStyle = colors.text;
    ctx.lineWidth = 3;
    ctx.strokeRect(0, 0, width - 6, height - 6);
    
    // Add a subtle inner border for depth
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.lineWidth = 1;
    ctx.strokeRect(2, 2, width - 10, height - 10);
    
    // Split text into lines for display using actual text measurement
    const maxWidth = width - 40; // Leave 20px margin on each side
    
    // Set font first so measureText works correctly
    ctx.font = '14px "Liberation Sans", "DejaVu Sans", Arial, sans-serif';
    
    const lineHeight = 22; // Line height for 14px font
    const textStartY = 70; // Where text starts
    const textEndY = height - 40; // Leave space for timestamp (height - 20 - 20 margin)
    const maxLines = calculateMaxLines(height, textStartY, textEndY, lineHeight);
    
    const lines = splitTextIntoLines(text, ctx, maxWidth, maxLines);
    
    // Debug: Log the lines array to see the order
    console.log(`📝 Text split into ${lines.length} lines:`, lines.map((line, i) => `${i}: "${line}"`));
    
    const timeText = formatTimeAgo(timestamp);
    
    // Set text color
    ctx.fillStyle = colors.text;
    
    // Draw header text with better font fallback for Azure/Linux environments
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    // Use simple text without emojis for better font compatibility
    const headerText = `${key}`;
    
    // Use fonts that are available in Linux systems (Liberation Sans is commonly available)
    ctx.font = '18px "Liberation Sans", "DejaVu Sans", Arial, sans-serif';
    
    try {
      ctx.fillText(headerText, (width - 8) / 2, 30);
    } catch (textError) {
      console.error('❌ Header text drawing failed:', textError);
    }
    
    // Draw separator line
    ctx.beginPath();
    ctx.moveTo(20, 45);
    ctx.lineTo(width - 28, 45);
    ctx.strokeStyle = colors.text;
    ctx.lineWidth = 1;
    ctx.stroke();
    
    // Draw note text with Linux-compatible fonts
    ctx.textAlign = 'left';
    ctx.font = '14px "Liberation Sans", "DejaVu Sans", Arial, sans-serif';
    
    lines.forEach((line, i) => {
      try {
        const yPos = 70 + i * lineHeight;
        ctx.fillText(line, 20, yPos);
      } catch (textError) {
        console.error(`❌ Failed to draw line ${i}:`, textError);
      }
    });
    
    // Draw timestamp with Linux-compatible fonts
    ctx.textAlign = 'center';
    ctx.font = '12px "Liberation Sans", "DejaVu Sans", Arial, sans-serif';
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    
    try {
      ctx.fillText(timeText, (width - 8) / 2, height - 20);
    } catch (textError) {
      console.error('❌ Timestamp drawing failed:', textError);
    }
    
    // Convert canvas to PNG buffer with error handling
    let pngBuffer;
    try {
      pngBuffer = canvas.toBuffer('image/png');
    } catch (bufferError) {
      console.error('❌ PNG buffer creation failed:', bufferError);
      return ''; // Return empty string to indicate failure
    }
    
    const base64Data = pngBuffer.toString('base64');
    console.log(`✅ PNG image generation completed successfully for key: ${key}`);
    return base64Data;
  } catch (error) {
    console.error('❌ PNG image generation failed:', error);
    console.error('Error details:', {
      name: error instanceof Error ? error.name : 'Unknown',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    // Return empty string to indicate failure
    return '';
  }
};

// Create simple text-based sticky note summary (multi-line format)
const createFormattedStickyNoteText = (key: string, text: string, timestamp: Date): string => {
  const color = getNoteColor(key);
  const timeAgo = formatTimeAgo(timestamp);
  
  // Return multi-line format with full text and original formatting preserved
  return `${color} "${key}"\n  "${text}"\n  (created ${timeAgo})`;
};

// New: format a single note item without repeating the key (used when group header already shows the key)
const createFormattedStickyNoteItemText = (key: string, text: string, timestamp: Date): string => {
  const color = getNoteColor(key);
  const timeAgo = formatTimeAgo(timestamp);

  // Show color and the note text, but omit the repeated key
  return `${color} "${text}"\n  (created ${timeAgo})`;
};

// Helper to log MCP responses consistently (added for better debugging)
const logMcpResponse = (content: any[]) => {
  console.log('📋 MCP response:');
  try {
    const textParts = (content || [])
      .filter((c: any) => c && c.type === 'text')
      .map((c: any) => c.text)
      .join('\n\n');
    if (textParts) console.log(textParts);

    for (const c of content || []) {
      if (c && c.type === 'image') {
        try {
          console.log(`🖼️ Image: ${c.mimeType}, data length=${String((c.data || '').length)}`);
        } catch (e) {
          console.log('🖼️ Image: (unable to compute data length)');
        }
      }
    }
  } catch (err) {
    console.error('Failed to log MCP response:', err);
  }
};

// Format timestamp relative to now
const formatTimeAgo = (timestamp: Date): string => {
  try {
    // Ensure we have a valid Date object
    const dateObj = timestamp instanceof Date ? timestamp : new Date(timestamp as any);
    
    // Check if the date is valid
    if (isNaN(dateObj.getTime())) {
      return 'Unknown time';
    }
    
    const now = new Date();
    const diffMs = now.getTime() - dateObj.getTime();
    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins} min${diffMins > 1 ? 's' : ''} ago`;
    if (diffHours < 24) return `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
    if (diffDays < 7) return `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)} week${Math.floor(diffDays / 7) > 1 ? 's' : ''} ago`;
    
    return dateObj.toLocaleDateString();
  } catch (error) {
    return 'Unknown time';
  }
};

// Get user partition key from user ID or fallback to anonymous
const getUserPartitionKey = (userId?: string): string => {
  // Always try to get or create a user ID first
  const autoUserId = getOrCreateUserId();
  
  if (userId || autoUserId) {
    return `user-${userId || autoUserId}`;
  }
  return 'user-anonymous';
};

// Helper to save a note to the in-memory fallback (centralized to avoid duplication)
const saveNoteInMemory = (partitionKey: string, key: string, text: string, timestamp: Date) => {
  if (!memoryNotes[partitionKey]) {
    memoryNotes[partitionKey] = {};
  }
  if (!memoryNotes[partitionKey][key]) {
    memoryNotes[partitionKey][key] = [];
  }
  memoryNotes[partitionKey][key].push({ id: randomUUID(), text, timestamp });
};

const stickNote = async (key: string, text: string): Promise<void> => {
  const timestamp = new Date();
  const userId = getOrCreateUserId();
  const partitionKey = getUserPartitionKey(userId);

  try {
    const client = await initializeAzureStorage();
    if (client) {
      // Store each note as its own entity with a unique rowKey and a noteKey for grouping
      console.log(`📝 Sticking note in Azure Table Storage for user ${partitionKey}, key: ${key}`);
      const entity: StickyNoteEntity = {
        partitionKey: partitionKey,
        rowKey: randomUUID(),
        noteKey: key,
        text: text,
        timestamp: timestamp
      };
      await client.upsertEntity(entity);
    } else {
      // Fallback to memory storage
      console.log(`📝 Sticking note in memory storage for user ${partitionKey}, key: ${key}`);
      saveNoteInMemory(partitionKey, key, text, timestamp);
    }
  } catch (error) {
    // Fallback to memory storage on error
    console.log(`📝 Azure storage failed, using memory storage for user ${partitionKey}, key: ${key}`);
    saveNoteInMemory(partitionKey, key, text, timestamp);
  }
};

// Helper to read the most recent note from the in-memory fallback
const getLatestNoteFromMemory = (partitionKey: string, key: string): { text: string; timestamp: Date; id?: string } | null => {
  const userNotes = memoryNotes[partitionKey]?.[key] || [];
  if (userNotes.length === 0) return null;
  // Create a shallow copy and sort by timestamp descending
  const sorted = (userNotes || []).slice().sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  const note = sorted[0];
  return { text: note.text, timestamp: note.timestamp, id: note.id };
};

const peelNote = async (key: string): Promise<{ text: string; timestamp: Date; id?: string } | null> => {
  const userId = getOrCreateUserId();
  const partitionKey = getUserPartitionKey(userId);
  try {
    const client = await initializeAzureStorage();
    if (client) {
      // Find entities with noteKey == key (or legacy rowKey == key)
      const entities = client.listEntities<StickyNoteEntity>({
        queryOptions: { filter: odata`PartitionKey eq '${partitionKey}' and (noteKey eq '${key}' or rowKey eq '${key}')` }
      });
      let latest: StickyNoteEntity | null = null;
      for await (const entity of entities) {
        if (!latest) { latest = entity; continue; }
        const latestTs = new Date(latest.timestamp as any);
        const thisTs = new Date(entity.timestamp as any);
        if (isNaN(latestTs.getTime()) || thisTs.getTime() > latestTs.getTime()) latest = entity;
      }
      if (!latest) return null;
      const ts = typeof latest.timestamp === 'string' ? new Date(latest.timestamp) : new Date(latest.timestamp as any);
      return { text: latest.text, timestamp: isNaN(ts.getTime()) ? new Date() : ts, id: latest.rowKey };
    } else {
      const memoryNote = getLatestNoteFromMemory(partitionKey, key);
      return memoryNote;
    }
  } catch (error) {
    const memoryNote = getLatestNoteFromMemory(partitionKey, key);
    return memoryNote;
  }
};


// Helper to build grouped notes response from the in-memory fallback (avoids duplicated code)
const getGroupedFromMemory = (partitionKey: string): Array<{ key: string; items: Array<{ id: string; text: string; timestamp: Date }> }> => {
  const userNotes = memoryNotes[partitionKey] || {};
  return Object.keys(userNotes).sort().map(k => ({
    key: k,
    items: (userNotes[k] || []).slice().sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
  }));
};

// Return grouped notes data for the current user (one entity per logical key, with items array)
const listNotesData = async (): Promise<Array<{ key: string; items: Array<{ id: string; text: string; timestamp: Date }> }>> => {
  const userId = getOrCreateUserId();
  const partitionKey = getUserPartitionKey(userId);
  try {
    const client = await initializeAzureStorage();
    if (client) {
      const entities = client.listEntities<StickyNoteEntity>({ queryOptions: { filter: odata`PartitionKey eq '${partitionKey}'` } });
      const groups: { [k: string]: Array<{ id: string; text: string; timestamp: Date }> } = {};
      for await (const entity of entities) {
        const noteKey = entity.noteKey || entity.rowKey;
        if (!groups[noteKey]) groups[noteKey] = [];
        const ts = typeof entity.timestamp === 'string' ? new Date(entity.timestamp) : new Date(entity.timestamp as any);
        groups[noteKey].push({ id: entity.rowKey, text: entity.text, timestamp: isNaN(ts.getTime()) ? new Date() : ts });
      }
      return Object.keys(groups).sort().map(k => ({ key: k, items: groups[k].sort((a,b) => b.timestamp.getTime() - a.timestamp.getTime()) }));
    } else {
      return getGroupedFromMemory(partitionKey);
    }
  } catch (error) {
    return getGroupedFromMemory(partitionKey);
  }
};

// Get note keys for the current user (unique logical keys)
const listNoteKeys = async (): Promise<string[]> => {
  const groups = await listNotesData();
  return groups.map(g => g.key).sort();
};

const removeNote = async (key: string): Promise<boolean> => {
  const userId = getOrCreateUserId();
  const partitionKey = getUserPartitionKey(userId);
  try {
    const client = await initializeAzureStorage();
    if (client) {
      // Find all entities matching this logical key and delete each one
      const entities = client.listEntities<StickyNoteEntity>({ queryOptions: { filter: odata`PartitionKey eq '${partitionKey}' and (noteKey eq '${key}' or rowKey eq '${key}')` } });
      let found = false;
      for await (const entity of entities) {
        found = true;
        try { await client.deleteEntity(partitionKey, entity.rowKey); } catch (err) { console.error('Error deleting entity', err); }
      }
      return found;
    } else {
      const userNotes = memoryNotes[partitionKey];
      if (userNotes && userNotes[key]) {
        delete userNotes[key];
        return true;
      }
      return false;
    }
  } catch (error) {
    const userNotes = memoryNotes[partitionKey];
    if (userNotes && userNotes[key]) {
      delete userNotes[key];
      return true;
    }
    return false;
  }
};

// Global variable to store current user ID for note operations
let currentUserId: string | undefined;

// Extract user ID from request query parameters
const getUserIdFromRequest = (req?: Request): string | undefined => {
  if (!req) {
    return undefined;
  }
  
  // Check for user ID in query parameters
  const queryUserId = req.query?.userId as string;
  if (queryUserId) {
    console.log(`📝 Using user ID from query parameter: ${queryUserId}`);
    return queryUserId;
  }
  
  // Check for a custom header that might be set by the client for persistence
  const customUserId = req.headers['x-mcp-user-id'] as string;
  if (customUserId) {
    console.log(`📝 Using custom user ID from header: ${customUserId}`);
    return customUserId;
  }
  
  return undefined;
};

// Auto-generate a persistent user ID based on client info or create a stable one
const getOrCreateUserId = (): string => {
  if (currentUserId) {
    return currentUserId;
  }
  
  // Priority 1: Check for environment variable (most persistent)
  const envUserId = process.env.MCP_USER_ID;
  if (envUserId) {
    currentUserId = envUserId;
    console.log(`📝 Using user ID from environment: ${currentUserId}`);
    return currentUserId;
  }
  
  // Priority 2: Generate a random persistent ID for this session
  // This will be consistent for the duration of the server process
  // but will create a new user space each time the server restarts
  currentUserId = `user-${randomUUID().substring(0, 8)}`;
  console.log(`📝 Generated random persistent user ID: ${currentUserId}`);
  console.log(`💡 To make this permanent, set MCP_USER_ID environment variable or use ?userId= in your MCP client URL`);
  
  return currentUserId;
};

// Generate a board image with multiple sticky notes using Canvas to create PNG
const generateNotesBoard = async (notes: Array<{key: string, text: string, timestamp: Date}>): Promise<string> => {
  try {
    console.log(`🖼️ Starting board PNG generation for ${notes.length} notes`);
    
    const noteWidth = 280;
    const noteHeight = 280;
    const margin = 20;
    const notesPerRow = 3;
    
    const rows = Math.ceil(notes.length / notesPerRow);
    const boardWidth = (noteWidth + margin) * notesPerRow + margin;
    const boardHeight = (noteHeight + margin) * rows + margin + 60; // Extra space for title
    
    console.log(`📐 Board dimensions: ${boardWidth}x${boardHeight} pixels`);
    console.log(`📋 Layout: ${rows} rows, ${notesPerRow} notes per row`);
    
    // Create canvas
    const canvas = createCanvas(boardWidth, boardHeight);
    const ctx = canvas.getContext('2d');
    // console.log(`✅ Board canvas created successfully`);
    
    // Draw board background
    ctx.fillStyle = '#F5F5F5';
    ctx.fillRect(0, 0, boardWidth, boardHeight);
    
    // Draw title with Linux-compatible fonts
    ctx.fillStyle = '#333333';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '20px "Liberation Sans", "DejaVu Sans", Arial, sans-serif';
    ctx.fillText('Sticky Notes Board', boardWidth / 2, 35);
    // console.log(`✅ Board title drawn`);
    
    // Generate notes
    for (let i = 0; i < notes.length; i++) {
      const note = notes[i];
      const row = Math.floor(i / notesPerRow);
      const col = i % notesPerRow;
      
      const x = margin + col * (noteWidth + margin);
      const y = 60 + margin + row * (noteHeight + margin);
      
      // console.log(`📝 Drawing note ${i + 1}/${notes.length}: "${note.key}" at position (${x}, ${y})`);
      
      const colors = getNoteColorHex(note.key);
      
      // Split text for display using actual text measurement
      const maxWidth = noteWidth - 20; // Leave 10px margin on each side
      
      // Set font first so measureText works correctly
      ctx.font = '11px "Liberation Sans", "DejaVu Sans", Arial, sans-serif';
      
      const lineHeight = 18; // Line height for 11px font
      const maxLines = calculateMaxLines(noteHeight, 45, noteHeight - 25, lineHeight);
      
      const lines = splitTextIntoLines(note.text, ctx, maxWidth, maxLines);
      
      // Debug: Log the lines for board notes
      console.log(`📝 Board note "${note.key}" split into ${lines.length} lines:`, lines.map((line, i) => `${i}: "${line}"`));
      
      const timeText = formatTimeAgo(note.timestamp);
      
      // Draw note shadow with enhanced effect for colored backgrounds
      ctx.fillStyle = 'rgba(0, 0, 0, 0.2)';
      ctx.fillRect(x + 3, y + 3, noteWidth, noteHeight);
      
      // Draw note background with color
      ctx.fillStyle = colors.bg;
      ctx.fillRect(x, y, noteWidth, noteHeight);
      
      // Draw note border with stronger effect
      ctx.strokeStyle = colors.text;
      ctx.lineWidth = 3;
      ctx.strokeRect(x, y, noteWidth, noteHeight);
      
      // Add subtle inner border for depth
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 2, y + 2, noteWidth - 4, noteHeight - 4);
      
      // Draw note header without emoji for better compatibility
      const headerText = `${note.key}`;
      ctx.fillStyle = colors.text;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '14px "Liberation Sans", "DejaVu Sans", Arial, sans-serif';
      ctx.fillText(headerText, x + noteWidth / 2, y + 20);
      
      // Draw separator line
      ctx.beginPath();
      ctx.moveTo(x + 10, y + 30); // Adjusted position
      ctx.lineTo(x + noteWidth - 10, y + 30);
      ctx.strokeStyle = colors.text;
      ctx.lineWidth = 1;
      ctx.stroke();
      
      // Draw note text with Linux-compatible fonts
      ctx.textAlign = 'left';
      ctx.font = '11px "Liberation Sans", "DejaVu Sans", Arial, sans-serif';
      
      lines.forEach((line, lineIndex) => {
        const yPos = y + 45 + lineIndex * lineHeight;
        console.log(`📍 Board note "${note.key}" line ${lineIndex}: "${line}" at Y=${yPos}`);
        ctx.fillText(line, x + 10, yPos);
      });
      
      // Draw timestamp with Linux-compatible fonts
      ctx.textAlign = 'center';
      ctx.font = '9px "Liberation Sans", "DejaVu Sans", Arial, sans-serif';
      ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
      ctx.fillText(timeText, x + noteWidth / 2, y + noteHeight - 12);
      
      // console.log(`✅ Note "${note.key}" drawn successfully`);
    }
    
    // Convert canvas to PNG buffer
    const pngBuffer = canvas.toBuffer('image/png');
    const base64Data = pngBuffer.toString('base64');
    
    // console.log(`📐 Board PNG generated successfully`);
    // console.log(`📊 Final stats: ${pngBuffer.length} bytes, base64 length: ${base64Data.length}`);
    // console.log(`🔍 Base64 preview: ${base64Data.substring(0, 50)}...`);
    
    return base64Data;
  } catch (error) {
    console.error('❌ PNG board generation failed:', error);
    console.error('Error details:', {
      name: error instanceof Error ? error.name : 'Unknown',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    // Return empty string to indicate failure
    return '';
  }
};

// Create an MCP server with implementation details
const getServer = () => {
  const server = new McpServer({
    name: 'azure-sticky-notes-server',
    version: '1.0.0'
  });

  // Register sticky note tools
  
  // Add a note
  server.registerTool(
    'addNote',
    {
      title: 'Add Note',
      description: 'Add a new sticky note with optional color-coded naming. Returns both formatted text and a visual image of the note.',
      inputSchema: {
        text: z.string().describe('The text content for your sticky note'),
        key: z.string().optional().describe('Optional name/key for the note (defaults to "default"). Use keywords like "work", "personal", "ideas", "quotes", "reminders" for colored notes'),
      },
    },
    async ({ text, key }): Promise<CallToolResult> => {
      try {
        const noteKey = key || DEFAULT_NOTE_KEY;
        await stickNote(noteKey, text);
        
        const timestamp = new Date();
        const formattedNote = createFormattedStickyNoteText(noteKey, text, timestamp);
        
        // Try to generate image, but fall back to text-only if it fails
        let imageContent: any = null;
        try {
          // console.log(`🎯 Attempting to generate image for noteKey: ${noteKey}`);
          const imageBase64 = await generateStickyNoteImage(noteKey, text, timestamp);
          // console.log(`🔄 Image generation returned data length: ${imageBase64.length}`);
          
          if (imageBase64) {
            // console.log(`✅ Image data validated, creating image content`);
            imageContent = {
              type: 'image',
              data: imageBase64,
              mimeType: 'image/png'
            };
            //console.log(`📋 Image content created:`, JSON.stringify(imageContent, null, 2));
          } else {
            console.log(`❌ Image base64 data is empty, skipping image content`);
          }
        } catch (imageError) {
          console.error('❌ Image generation failed:', imageError);
          // Continue without image
        }
        
        // Build response content (text summary + optional image)
        const content: any[] = [
          {
            type: 'text',
            text: [
              '📌 Note Added',
              '',
              formattedNote,
              '',
              imageContent ? '🖼️ Visual note image' : '⚠️ Image generation failed - showing text-only version',
              '',
              `👤 ${getUserPartitionKey(getOrCreateUserId())}`
            ].join('\n'),
          }
        ];
        if (imageContent) {
          content.push(imageContent);
        }

        // Log the MCP response consistently
        logMcpResponse(content);
        return { content };
      } catch (error) {
        const errorContent: CallToolResult = {
          content: [
            {
              type: 'text',
              text: `❌ Failed to stick note: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
        };
        logMcpResponse(errorContent.content);
        return errorContent;
      }
    }
  );

  // Remove a note
  server.registerTool(
    'removeNote',
    {
      title: 'Remove Note',
      description: 'Remove a sticky note from your board by its name/key.',
      inputSchema: {
        key: z.string().describe('The name/key of the sticky note to remove'),
      },
    },
    async ({ key }): Promise<CallToolResult> => {
      try {
        const success = await removeNote(key);
        
        if (success) {
          const color = getNoteColor(key);
          const resp: CallToolResult = {
            content: [
              {
                type: 'text',
                text: `🗑️ Note Removed!\n\n${color} "${key}" has been peeled off your board\n👤 ${getUserPartitionKey(getOrCreateUserId())}`,
              },
            ],
          };
          logMcpResponse(resp.content);
          return resp;
        } else {
          const resp: CallToolResult = {
            content: [
              {
                type: 'text',
                text: `📝 No sticky note found with name: "${key}"\n👤 ${getUserPartitionKey(getOrCreateUserId())}`,
              },
            ],
          };
          logMcpResponse(resp.content);
          return resp;
        }
      } catch (error) {
        const errorContent: CallToolResult = {
          content: [
            {
              type: 'text',
              text: `❌ Failed to remove note: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
        };
        logMcpResponse(errorContent.content);
        return errorContent;
      }
    }
  );

  // Get a note
  server.registerTool(
    'getNote',
    {
      title: 'Get Note',
      description: 'Get and view a sticky note by its name/key. Returns both formatted text and a visual image of the note.',
      inputSchema: {
        key: z.string().optional().describe('Optional name/key for the note (defaults to "default")'),
      },
    },
    async ({ key }): Promise<CallToolResult> => {
      try {
        const noteKey = key || DEFAULT_NOTE_KEY;
        const grouped = await listNotesData();
        const group = grouped.find(g => g.key === noteKey);
        if (!group || group.items.length === 0) {
          return { content: [ { type: 'text', text: `📝 No sticky note found with name: "${noteKey}"\n👤 ${getUserPartitionKey(getOrCreateUserId())}` } ] };
        }

        const parts: string[] = ['📌 Here are the sticky note(s):', ''];
        for (const item of group.items) {
          parts.push(createFormattedStickyNoteItemText(group.key, item.text, item.timestamp));
        }
        parts.push('', `👤 ${getUserPartitionKey(getOrCreateUserId())}`);

        // Attach image for the most recent item if available
        let imageContent: any = null;
        try {
          const latest = group.items[0];
          const imageBase64 = await generateStickyNoteImage(group.key, latest.text, latest.timestamp);
          if (imageBase64) imageContent = { type: 'image', data: imageBase64, mimeType: 'image/png' };
        } catch (imageError) {
          console.error('Image generation failed for getNote:', imageError);
        }

        const content: any[] = [ { type: 'text', text: parts.join('\n') } ];
        if (imageContent) content.push(imageContent);

        // Log MCP response
        logMcpResponse(content);
        return { content };
      } catch (error) {
        const errorContent: CallToolResult = {
          content: [
            {
              type: 'text',
              text: `❌ Failed to peel note: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
        };
        logMcpResponse(errorContent.content);
        return errorContent;
      }
    }
  );

  // List all notes (Notes Board)
  server.registerTool(
    'listNotes',
    {
      title: 'List all Notes',
      description: 'Display all your sticky notes in a colorful board layout. Returns both formatted text and a visual board image.',
      inputSchema: {}, // No input needed
    },
    async (): Promise<CallToolResult> => {
      try {
       
        // Fetch grouped notes once to avoid duplicate storage calls
        const grouped = await listNotesData();
        if (grouped.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: [
                  `🗂️ Your Sticky Notes Board • 👤 ${getUserPartitionKey(getOrCreateUserId())}`,
                  '',
                  '📝 No sticky notes found. Create your first note to get started!',
                  '',
                  '💡 Tip: Use different note names to organize by color:',
                  '   🟡 personal  🟢 work  🔵 ideas  🟣 quotes  🟠 reminders  ⚪ default'
                ].join('\n'),
              },
            ],
          };
        }

        const notesData: Array<{ key: string; text: string; timestamp: Date }> = [];
        for (const group of grouped) {
          for (const item of group.items) {
            notesData.push({ key: group.key, text: item.text, timestamp: item.timestamp });
          }
        }

        // Log all keys and their text for debugging purposes (show key, text and timestamp)
        try {
          const partition = getUserPartitionKey(getOrCreateUserId());
          console.log(`🗂️ Listing notes for ${partition} - keys: ${grouped.length}, items: ${notesData.length}`);
          for (const group of grouped) {
            console.log(` - ${group.key} (${group.items.length} item${group.items.length !== 1 ? 's' : ''}):`);
            for (const item of group.items) {
              const singleLineText = typeof item.text === 'string' ? item.text.replace(/\r?\n/g, ' ↵ ') : String(item.text);
              console.log(`     • ${singleLineText} (${formatTimeAgo(item.timestamp)})`);
            }
          }
        } catch (logError) {
          console.error('Failed to log grouped notes for listNotes:', logError);
        }

        // Generate text representation grouped by key
        let textResponse = `🗂️ Your Sticky Notes Board • 👤 ${getUserPartitionKey(getOrCreateUserId())}\n\nYou have ${notesData.length} sticky note${notesData.length !== 1 ? 's' : ''} across ${grouped.length} key${grouped.length !== 1 ? 's' : ''}:\n\n`;
        for (const group of grouped) {
          textResponse += `${getNoteColor(group.key)} "${group.key}" (${group.items.length} item${group.items.length !== 1 ? 's' : ''}):\n`;
          for (const item of group.items) {
            const formattedNote = createFormattedStickyNoteItemText(group.key, item.text, item.timestamp);
            const indented = formattedNote.split('\n').map((l, i) => i === 0 ? `  - ${l}` : `    ${l}`).join('\n');
            textResponse += indented + '\n';
          }
          textResponse += '\n';
        }

        // Generate board image with error handling
        let boardImageContent: any = null;
        let boardGenerationError = '';
        try {
          // console.log(`🎯 Starting board image generation for ${notesData.length} notes`);
          const boardImage = await generateNotesBoard(notesData);
          // console.log(`🔄 Board generation returned data length: ${boardImage.length}`);
          
          if (boardImage) {
            // console.log(`✅ Board image data validated, creating image content`);
            boardImageContent = {
              type: 'image',
              data: boardImage,
              mimeType: 'image/png'
            };
            console.log(`📋 Board image content created successfully`);
          } else {
            console.log(`❌ Board image generation returned empty data`);
            boardGenerationError = 'Board image generation returned empty data';
          }
        } catch (imageError) {
          console.error('❌ Board image generation failed:', imageError);
          boardGenerationError = `Board image generation failed: ${imageError instanceof Error ? imageError.message : 'Unknown error'}`;
          // Continue without image
        }
        
        const content: any[] = [
          {
            type: 'text',
            text: [
              textResponse.trimEnd(),
              boardGenerationError ? `\n⚠️ Board image generation issue: ${boardGenerationError}` : ''
            ].join('\n')
          }
        ];
        
        // Add image if generation was successful
        if (boardImageContent) {
          content.push(boardImageContent);
          console.log(`✅ Board image added to response`);
        } else {
          console.log(`❌ No board image to add to response`);
        }

        // Log MCP response
        logMcpResponse(content);
        return { content };
      } catch (error) {
        const errorContent: CallToolResult = {
          content: [
            {
              type: 'text',
              text: `❌ Failed to load notes board: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
        };
        logMcpResponse(errorContent.content);
        return errorContent;
      }
    }
  );

  // Clear all notes
  server.registerTool(
    'clearNotes',
    {
      title: 'Clear Notes',
      description: 'Remove all sticky notes from your board (use with caution)',
      inputSchema: {}, // No input needed
    },
    async (): Promise<CallToolResult> => {
      try {
        const keys = await listNoteKeys();
        let deletedCount = 0;
        
        for (const key of keys) {
          const success = await removeNote(key);
          if (success) {
            deletedCount++;
          }
        }
        
        const contentResp: CallToolResult = {
          content: [
            {
              type: 'text',
              text: `🗂️ Board Cleared!\n\n🗑️ Successfully removed all sticky notes from your board\n📊 Deleted ${deletedCount} note${deletedCount !== 1 ? 's' : ''} total\n👤 ${getUserPartitionKey(getOrCreateUserId())}\n\n✨ Fresh start! Ready for new notes.`,
            },
          ],
        };

        logMcpResponse(contentResp.content);
        return contentResp;
      } catch (error) {
        const errorContent: CallToolResult = {
          content: [
            {
              type: 'text',
              text: `❌ Failed to clear board: ${error instanceof Error ? error.message : 'Unknown error'}`,
            },
          ],
        };
        logMcpResponse(errorContent.content);
        return errorContent;
      }
    }
  );

  return server;
};

// Start server with STDIO transport
async function startStdioServer() {
  // Use stderr for logging when using STDIO transport to avoid interfering with MCP protocol
  console.error('🚀 Starting MCP Sticky Notes server with STDIO transport...');
  
  const server = getServer(); // No session ID for STDIO - will use anonymous
  const transport = new StdioServerTransport();
  
  console.error('✅ Connecting server...');
  await server.connect(transport);
  console.error('✅ Sticky Notes server connected on stdio');
}

// Start server with HTTP transport
async function startHttpServer() {
  console.log('🚀 Starting MCP Sticky Notes server with HTTP transport...');
  
  const app = express();
  app.use(express.json());

  // Map to store transports by session ID
  const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

  // MCP POST endpoint
  const mcpPostHandler = async (req: Request, res: Response) => {
    console.log('Received MCP request:', req.body);

    // Quick direct handler for the exact method names we need to support immediately
    try {
      if (req.body && typeof req.body.method === 'string') {
        if (req.body.method === 'logging/setLevel') {
          const requested = String(req.body.params?.level || '').toLowerCase();
          const valid = ['error','warn','info','debug','trace','off'];
          if (!requested || !valid.includes(requested)) {
            res.status(200).json({ jsonrpc: '2.0', id: req.body.id ?? null, error: { code: -32602, message: `Invalid params: level must be one of ${valid.join(', ')}` } });
            return;
          }
          process.env.LOG_LEVEL = requested;
          console.log(`🔧 Direct handler: Log level set to ${requested}`);
          res.status(200).json({ jsonrpc: '2.0', id: req.body.id ?? null, result: { content: [ { type: 'text', text: `✅ Log level set to ${requested}` } ] } });
          return;
        }

        if (req.body.method === 'logging/getLevel') {
          const current = (process.env.LOG_LEVEL || 'info').toLowerCase();
          res.status(200).json({ jsonrpc: '2.0', id: req.body.id ?? null, result: { content: [ { type: 'text', text: `ℹ️ Current log level: ${current}` } ] } });
          return;
        }
      }
    } catch (err) {
      console.error('Direct logging handler error:', err);
      // fall through to normal handling
    }

    try {
      // Extract user ID from request for this session
      const requestUserId = getUserIdFromRequest(req);
      if (requestUserId) {
        currentUserId = requestUserId;
      }
      
      // Check for existing session ID
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports[sessionId]) {
        // Reuse existing transport
        transport = transports[sessionId];
      } else if (!sessionId && isInitializeRequest(req.body)) {
        // New initialization request
        //const eventStore = new InMemoryEventStore();
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          //eventStore, // Enable resumability
          enableJsonResponse: true, // Enable JSON response mode
          onsessioninitialized: (sessionId) => {
            // Store the transport by session ID when session is initialized
            // This avoids race conditions where requests might come in before the session is stored
            console.log(`Session initialized with ID: ${sessionId}`);
            transports[sessionId] = transport;
          }
        });

        // Set up onclose handler to clean up transport when closed
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && transports[sid]) {
            console.log(`Transport closed for session ${sid}, removing from transports map`);
            delete transports[sid];
          }
        };

        // Connect the transport to the MCP server BEFORE handling the request
        const server = getServer(); // Will get session ID from transport after initialization
        await server.connect(transport);

        // Map the initial request if it uses a non-tool-friendly method name
        const mapMethodIfNeeded_init = (body: any) => {
          if (!body || typeof body.method !== 'string') return body;
          // Minimal mapping for the client's exact method names
          if (body.method === 'logging/setLevel') {
            const clone = JSON.parse(JSON.stringify(body));
            clone.method = 'logging-set-level';
            return clone;
          }
          if (body.method === 'logging/getLevel') {
            const clone = JSON.parse(JSON.stringify(body));
            clone.method = 'logging-get-level';
            return clone;
          }
          return body;
        };

        await transport.handleRequest(req, res, mapMethodIfNeeded_init(req.body));
        return; // Already handled
      } else {
        // Invalid request - no session ID or not initialization request
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: No valid session ID provided',
          },
          id: null,
        });
        return;
      }

      // Handle the request with existing transport - no need to reconnect
      // The existing transport is already connected to the server

      // Minimal mapping: only handle the exact methods your client sends
      const mapMethodIfNeeded = (body: any) => {
        if (!body || typeof body.method !== 'string') return body;
        if (body.method === 'logging/setLevel') {
          const clone = JSON.parse(JSON.stringify(body));
          clone.method = 'logging-set-level';
          return clone;
        }
        if (body.method === 'logging/getLevel') {
          const clone = JSON.parse(JSON.stringify(body));
          clone.method = 'logging-get-level';
          return clone;
        }
        return body;
      };

      const mappedBody = mapMethodIfNeeded(req.body);
      await transport.handleRequest(req, res, mappedBody);
    } catch (error) {
      console.error('Error handling MCP request:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error',
          },
          id: null,
        });
      }
    }
  };

  app.post('/mcp', mcpPostHandler);

  // Handle GET requests for SSE streams (using built-in support from StreamableHTTP)
  const mcpGetHandler = async (req: Request, res: Response) => {
    // Extract user ID from request for this session
    const requestUserId = getUserIdFromRequest(req);
    if (requestUserId) {
      currentUserId = requestUserId;
    }
    
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }

    // Check for Last-Event-ID header for resumability
    const lastEventId = req.headers['last-event-id'] as string | undefined;
    if (lastEventId) {
      console.log(`Client reconnecting with Last-Event-ID: ${lastEventId}`);
    } else {
      console.log(`Establishing new SSE stream for session ${sessionId}`);
    }

    const transport = transports[sessionId];
    await transport.handleRequest(req, res);
  };

  app.get('/mcp', mcpGetHandler);

  // Handle DELETE requests for session termination (according to MCP spec)
  const mcpDeleteHandler = async (req: Request, res: Response) => {
    // Extract user ID from request for this session
    const requestUserId = getUserIdFromRequest(req);
    if (requestUserId) {
      currentUserId = requestUserId;
    }
    
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send('Invalid or missing session ID');
      return;
    }

    console.log(`Received session termination request for session ${sessionId}`);

    try {
      const transport = transports[sessionId];
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error('Error handling session termination:', error);
      if (!res.headersSent) {
        res.status(500).send('Error processing session termination');
      }
    }
  };

  app.delete('/mcp', mcpDeleteHandler);

  const port = parseInt(process.env.PORT || '3000', 10);
  const host = process.env.HOST || '0.0.0.0'; // Azure requires binding to 0.0.0.0

  app.listen(port, host, () => {
    console.log(`✅ MCP Sticky Notes Server listening on ${host}:${port}`);
  });

  // Handle server shutdown
  process.on('SIGINT', async () => {
    console.log('Shutting down Sticky Notes HTTP server...');

    // Close all active transports to properly clean up resources
    for (const sessionId in transports) {
      try {
        console.log(`Closing transport for session ${sessionId}`);
        await transports[sessionId].close();
        delete transports[sessionId];
      } catch (error) {
        console.error(`Error closing transport for session ${sessionId}:`, error);
      }
    }
    console.log('Sticky Notes HTTP server shutdown complete');
    process.exit(0);
  });
}

// Main function to start the appropriate server based on configuration
async function main() {
  // Check storage configuration at startup
  console.log('🔵 Azure Table Storage configured with hybrid authentication (Production mode)');
  console.log('🔐 Primary: Managed Identity, Fallback: Storage Key');
  
  if (AZURE_STORAGE_KEY) {
    console.log('🔑 Storage Key available as backup authentication method');
  } else {
    console.log('⚠️ No Storage Key available - Managed Identity only');
  }

  if (TRANSPORT_TYPE === 'stdio') {
    // Use stderr for logging in STDIO mode to avoid interfering with MCP protocol
    console.error(`🔧 Transport Type: ${TRANSPORT_TYPE.toUpperCase()}`);
    await startStdioServer();
  } else if (TRANSPORT_TYPE === 'http') {
    // Use stdout for HTTP mode (normal logging)
    console.log(`🔧 Transport Type: ${TRANSPORT_TYPE.toUpperCase()}`);
    await startHttpServer();
  } else {
    console.error(`❌ Invalid transport type: ${TRANSPORT_TYPE}. Must be 'stdio' or 'http'`);
    process.exit(1);
  }
}

// Start the server
main().catch((error) => {
  console.error("Sticky Notes server error:", error);
  process.exit(1);
});
