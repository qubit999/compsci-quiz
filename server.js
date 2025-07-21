const express = require('express');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static('public'));

// Load all question files
const questionsPath = path.join(__dirname, 'questions');
const topics = {};

// Read all question files
fs.readdirSync(questionsPath).forEach(file => {
    if (file.endsWith('_questions.json')) {
        const topicName = file.replace('_questions.json', '');
        const topicDisplayName = topicName.charAt(0).toUpperCase() + topicName.slice(1).replace('_', ' ');
        topics[topicName] = {
            displayName: topicDisplayName,
            questions: JSON.parse(fs.readFileSync(path.join(questionsPath, file), 'utf8'))
        };
    }
});

// Shuffle array function
function shuffleArray(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

// Get available topics
app.get('/topics', (req, res) => {
    const topicList = Object.keys(topics).map(key => ({
        id: key,
        name: topics[key].displayName,
        questionCount: topics[key].questions.length
    }));
    res.json(topicList);
});

// Store active games
const games = new Map();

// Generate game invite link
app.post('/create-game', express.json(), (req, res) => {
    const { topic } = req.body;
    
    if (!topics[topic]) {
        return res.status(400).json({ error: 'Invalid topic' });
    }
    
    // Create a deep copy of questions and shuffle them
    const gameQuestions = JSON.parse(JSON.stringify(topics[topic].questions));
    const shuffledQuestions = shuffleArray(gameQuestions);
    
    // Shuffle the options for each question
    shuffledQuestions.forEach(question => {
        // Store the correct answer before shuffling
        const correctAnswer = question.correct;
        // Shuffle the options
        question.options = shuffleArray(question.options);
        // Make sure the correct answer reference is still valid
        question.correct = correctAnswer;
    });
    
    const gameId = uuidv4();
    games.set(gameId, {
        id: gameId,
        topic: topic,
        questions: shuffledQuestions,
        players: new Map(),
        currentQuestion: 0,
        answers: new Map(),
        started: false,
        scores: new Map()
    });
    
    res.json({ 
        gameId, 
        inviteLink: `${req.protocol}://${req.get('host')}/game.html?id=${gameId}`,
        topicName: topics[topic].displayName
    });
});

const server = app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

// WebSocket server
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws, req) => {
    const urlParams = new URLSearchParams(req.url.split('?')[1]);
    const gameId = urlParams.get('gameId');
    const playerId = uuidv4();

    ws.on('message', (message) => {
        const data = JSON.parse(message);
        const game = games.get(gameId);

        if (!game) {
            ws.send(JSON.stringify({ type: 'error', message: 'Game not found' }));
            return;
        }

        switch (data.type) {
            case 'join':
                handleJoin(game, playerId, data.name, ws);
                break;
            case 'start':
                handleStart(game);
                break;
            case 'answer':
                handleAnswer(game, playerId, data.answer);
                break;
            case 'disconnect':
                handleDisconnect(game, playerId);
                break;
        }
    });

    ws.on('close', () => {
        const game = games.get(gameId);
        if (game) {
            handleDisconnect(game, playerId);
        }
    });
});

function handleJoin(game, playerId, playerName, ws) {
    game.players.set(playerId, { id: playerId, name: playerName, ws });
    game.scores.set(playerId, 0);
    
    // Send game state to new player
    ws.send(JSON.stringify({
        type: 'joined',
        playerId,
        players: Array.from(game.players.values()).map(p => ({ id: p.id, name: p.name })),
        started: game.started,
        topic: topics[game.topic].displayName
    }));

    // Notify all players
    broadcastToGame(game, {
        type: 'playerJoined',
        player: { id: playerId, name: playerName },
        players: Array.from(game.players.values()).map(p => ({ id: p.id, name: p.name }))
    });
}

function handleStart(game) {
    game.started = true;
    sendQuestion(game);
}

function handleAnswer(game, playerId, answer) {
    if (!game.answers.has(game.currentQuestion)) {
        game.answers.set(game.currentQuestion, new Map());
    }
    
    const questionAnswers = game.answers.get(game.currentQuestion);
    questionAnswers.set(playerId, answer);

    // Check if answer is correct
    const currentQuestion = game.questions[game.currentQuestion];
    if (answer === currentQuestion.correct) {
        game.scores.set(playerId, game.scores.get(playerId) + 1);
    }

    // Send answer feedback to player with both selected answer and correct answer
    const player = game.players.get(playerId);
    if (player && player.ws) {
        player.ws.send(JSON.stringify({
            type: 'answerFeedback',
            correct: answer === currentQuestion.correct,
            selectedAnswer: answer,
            correctAnswer: currentQuestion.correct
        }));
    }

    // Check if all players have answered
    if (questionAnswers.size === game.players.size) {
        // Send feedback to all players about correct answer (for those who might have joined late)
        broadcastToGame(game, {
            type: 'showCorrectAnswer',
            correctAnswer: currentQuestion.correct
        });

        // Wait 3 seconds before showing results
        setTimeout(() => {
            // Show results
            broadcastToGame(game, {
                type: 'questionResults',
                correct: currentQuestion.correct,
                scores: Array.from(game.scores.entries()).map(([id, score]) => ({
                    playerId: id,
                    playerName: game.players.get(id).name,
                    score
                }))
            });

            // Move to next question after another delay
            setTimeout(() => {
                game.currentQuestion++;
                game.answers.delete(game.currentQuestion - 1);

                if (game.currentQuestion < game.questions.length) {
                    sendQuestion(game);
                } else {
                    endGame(game);
                }
            }, 3000);
        }, 3000); // 3 second delay to show correct/incorrect answers
    }
}

function sendQuestion(game) {
    const question = game.questions[game.currentQuestion];
    broadcastToGame(game, {
        type: 'question',
        questionNumber: game.currentQuestion + 1,
        totalQuestions: game.questions.length,
        question: question.question,
        options: question.options
    });
}

function endGame(game) {
    const finalScores = Array.from(game.scores.entries())
        .map(([id, score]) => ({
            playerId: id,
            playerName: game.players.get(id).name,
            score
        }))
        .sort((a, b) => b.score - a.score);

    broadcastToGame(game, {
        type: 'gameEnd',
        scores: finalScores
    });

    // Clean up game after 5 minutes
    setTimeout(() => {
        games.delete(game.id);
    }, 300000);
}

function handleDisconnect(game, playerId) {
    game.players.delete(playerId);
    game.scores.delete(playerId);
    
    broadcastToGame(game, {
        type: 'playerLeft',
        playerId,
        players: Array.from(game.players.values()).map(p => ({ id: p.id, name: p.name }))
    });

    // If no players left, delete the game
    if (game.players.size === 0) {
        games.delete(game.id);
    }
}

function broadcastToGame(game, message) {
    game.players.forEach(player => {
        if (player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(JSON.stringify(message));
        }
    });
}