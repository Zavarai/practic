const fs = require('fs');

console.log('='.repeat(60));
console.log('АНАЛИЗ АНОМАЛИЙ В ЗАЯВКАХ НА ЗАКУПКУ');
console.log('='.repeat(60));

console.log('\n[1/5] Загрузка данных...');

// Чтение CSV
const csvContent = fs.readFileSync('students (1).csv', 'utf-8');
const lines = csvContent.trim().split('\n');
const headers = lines[0].split(',');

// Парсинг данных
const data = lines.slice(1).map(line => {
    const values = [];
    let current = '';
    let inQuotes = false;

    for (let char of line) {
        if (char === '"') {
            inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
            values.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    values.push(current.trim());

    const row = {};
    headers.forEach((header, i) => {
        row[header] = values[i] || '';
    });
    return row;
});

console.log(`✓ Загружено ${data.length} событий`);

// Группировка по процессам
const processes = new Map();
data.forEach(row => {
    const pid = row.ProcessInstanceId;
    if (!processes.has(pid)) {
        processes.set(pid, []);
    }
    processes.get(pid).push(row);
});

console.log(`✓ Уникальных процессов: ${processes.size}`);

// Сортировка событий внутри каждого процесса
processes.forEach(events => {
    events.sort((a, b) => parseInt(a.EventIndex) - parseInt(b.EventIndex));
});

console.log('\n[2/5] Анализ типов заявок...');
const typeCount = {};
processes.forEach(events => {
    const type = events[0].RequestType;
    typeCount[type] = (typeCount[type] || 0) + 1;
});

console.log('Типы заявок:');
Object.entries(typeCount).forEach(([type, count]) => {
    console.log(`  ${type}: ${count}`);
});

console.log('\n[3/5] Определение типичного поведения...');

const anomalies = [];

function addAnomaly(pid, type, explanation) {
    anomalies.push({
        ProcessInstanceId: pid,
        AnomalyType: type,
        Explanation: explanation
    });
}

// Типичная длительность (в часах) для каждого типа задачи
const typicalDurations = {
    'Проверка заявки': { min: 0.5, max: 48 },
    'Согласование руководителем': { min: 0.5, max: 72 },
    'Проверка бюджета': { min: 0.5, max: 48 },
    'Юридическая проверка': { min: 1, max: 72 },
    'Исполнение заявки': { min: 1, max: 168 },
    'Доработка заявки': { min: 0.5, max: 120 }
};

console.log('\n[4/5] Поиск аномалий...');

let processCount = 0;
processes.forEach((events, pid) => {
    processCount++;
    if (processCount % 100 === 0) {
        process.stdout.write(`\rОбработано процессов: ${processCount}/${processes.size}`);
    }

    const reqType = events[0].RequestType;
    const amount = parseFloat(events[0].Amount);

    // Извлекаем информацию о процессе
    const activities = events.map(e => e.ActivityName);
    const eventTypes = events.map(e => e.EventType);
    const roles = events.filter(e => e.Role).map(e => e.Role);
    const results = events.filter(e => e.Result).map(e => e.Result);

    const isCompleted = events.some(e => e.EventType === 'process_completed');
    const finalResult = isCompleted ? events.find(e => e.EventType === 'process_completed').Result : null;

    // === 1. ПРОВЕРКА НАЧАЛА ПРОЦЕССА ===
    if (eventTypes[0] !== 'process_started') {
        addAnomaly(pid, 'Неверное начало', 'Процесс не начинается с process_started');
    }

    // === 2. ПРОВЕРКА АВТОМАТИЧЕСКОЙ РЕГИСТРАЦИИ ===
    const hasAutoComplete = events.some(e => e.EventType === 'automatic_completed');
    if (!hasAutoComplete && events.length > 1) {
        addAnomaly(pid, 'Отсутствует регистрация', 'Нет automatic_completed после старта');
    }

    // === 3. ПРОВЕРКА РОЛЕЙ ===
    const expectedRoles = {
        'Проверка заявки': ['specialist'],
        'Согласование руководителем': ['manager'],
        'Проверка бюджета': ['finance'],
        'Юридическая проверка': ['legal'],
        'Исполнение заявки': ['procurement'],
        'Доработка заявки': ['requester']
    };

    events.filter(e => e.EventType === 'task_completed').forEach(task => {
        const activity = task.ActivityName;
        const role = task.Role;

        if (expectedRoles[activity] && !expectedRoles[activity].includes(role)) {
            addAnomaly(pid, 'Неверная роль',
                `Этап "${activity}" выполнен ролью ${role}, ожидалась ${expectedRoles[activity].join(' или ')}`);
        }
    });

    // === 4. УЧАСТИЕ AUDITOR ===
    if (roles.includes('auditor')) {
        const auditorTasks = events.filter(e => e.Role === 'auditor' && e.EventType === 'task_completed');
        if (auditorTasks.length > 0) {
            addAnomaly(pid, 'Внеплановая проверка',
                `Участие auditor на этапе "${auditorTasks[0].ActivityName}"`);
        }
    }

    // === 5. ПРОВЕРКА ОБЯЗАТЕЛЬНЫХ ЭТАПОВ ===
    if (isCompleted && finalResult === 'fulfilled') {
        let required = ['Проверка заявки', 'Согласование руководителем', 'Проверка бюджета'];

        if (reqType === 'contract') {
            required.push('Юридическая проверка');
        }
        required.push('Исполнение заявки');

        required.forEach(reqActivity => {
            if (!activities.includes(reqActivity)) {
                addAnomaly(pid, 'Пропущен обязательный этап',
                    `Успешная заявка без этапа "${reqActivity}"`);
            }
        });
    }

    // === 6. ПРОВЕРКА ДЛИТЕЛЬНОСТИ ЗАДАЧ ===
    const taskMap = new Map();
    events.forEach(e => {
        if (e.TaskId) {
            if (!taskMap.has(e.TaskId)) {
                taskMap.set(e.TaskId, []);
            }
            taskMap.get(e.TaskId).push(e);
        }
    });

    taskMap.forEach((taskEvents, taskId) => {
        const created = taskEvents.find(e => e.EventType === 'task_created');
        const completed = taskEvents.find(e => e.EventType === 'task_completed');

        if (created && completed) {
            const start = new Date(created.Timestamp);
            const end = new Date(completed.Timestamp);
            const durationHours = (end - start) / (1000 * 60 * 60);
            const activityName = created.ActivityName;

            // Очень быстрое выполнение (< 1 минуты)
            if (durationHours < 0.0167) {
                addAnomaly(pid, 'Слишком быстро',
                    `Задача "${activityName}" выполнена за ${(durationHours * 60).toFixed(1)} минут (< 1 мин)`);
            }

            // Очень долгое выполнение (> 30 дней)
            if (durationHours > 720) {
                addAnomaly(pid, 'Чрезмерная длительность',
                    `Задача "${activityName}" выполнялась ${(durationHours / 24).toFixed(1)} дней (> 30 дней)`);
            }

            // Проверка по типичным диапазонам
            if (typicalDurations[activityName]) {
                const { min, max } = typicalDurations[activityName];
                if (durationHours < min) {
                    addAnomaly(pid, 'Подозрительно быстро',
                        `Задача "${activityName}" за ${durationHours.toFixed(1)}ч (обычно > ${min}ч)`);
                } else if (durationHours > max) {
                    addAnomaly(pid, 'Подозрительно долго',
                        `Задача "${activityName}" за ${(durationHours / 24).toFixed(1)} дней (обычно < ${max / 24} дней)`);
                }
            }
        }
    });

    // === 7. ПРОВЕРКА ВОЗВРАТОВ ===
    const returnEvents = events.filter(e => e.Result === 'return');
    returnEvents.forEach(ret => {
        const retIndex = parseInt(ret.EventIndex);
        const afterReturn = events.filter(e => parseInt(e.EventIndex) > retIndex);
        const afterActivities = afterReturn.map(e => e.ActivityName);

        if (!afterActivities.includes('Доработка заявки') && afterReturn.length > 0) {
            addAnomaly(pid, 'Возврат без доработки',
                `После возврата на "${ret.ActivityName}" нет доработки`);
        }
    });

    // === 8. ДУБЛИКАТЫ ЭТАПОВ ===
    for (let i = 0; i < activities.length - 1; i++) {
        if (activities[i] === activities[i + 1] &&
            activities[i] !== 'Проверка заявки' &&
            activities[i] !== '') {
            addAnomaly(pid, 'Дубликат этапа',
                `Этап "${activities[i]}" повторяется дважды подряд`);
            break;
        }
    }

    // === 9. АНОМАЛЬНЫЕ СУММЫ ===
    if (amount > 1000000) {
        addAnomaly(pid, 'Аномально большая сумма',
            `Сумма ${amount.toFixed(2)} руб превышает 1 млн`);
    }

    if (amount <= 0) {
        addAnomaly(pid, 'Некорректная сумма',
            `Сумма ${amount} <= 0`);
    }

    // === 10. ЗАВИСШИЕ ПРОЦЕССЫ ===
    if (!isCompleted) {
        const startTime = new Date(events[0].Timestamp);
        const cutoffTime = new Date('2026-07-01T00:00:00+03:00');
        const daysOpen = (cutoffTime - startTime) / (1000 * 60 * 60 * 24);

        if (daysOpen > 150) {
            addAnomaly(pid, 'Зависший процесс',
                `Процесс открыт ${daysOpen.toFixed(0)} дней без завершения (> 150 дней)`);
        }
    }

    // === 11. ПОВТОРНЫЕ СОГЛАСОВАНИЯ БЕЗ ВОЗВРАТА ===
    const approvals = events.filter(e =>
        e.ActivityName === 'Согласование руководителем' &&
        e.EventType === 'task_completed'
    );

    if (approvals.length > 1) {
        for (let i = 0; i < approvals.length - 1; i++) {
            const idx1 = parseInt(approvals[i].EventIndex);
            const idx2 = parseInt(approvals[i + 1].EventIndex);

            const between = events.filter(e => {
                const idx = parseInt(e.EventIndex);
                return idx > idx1 && idx < idx2 && e.Result === 'return';
            });

            if (between.length === 0) {
                addAnomaly(pid, 'Повторное согласование',
                    'Несколько согласований без промежуточного возврата');
                break;
            }
        }
    }
});

console.log(`\n\n[5/5] Найдено аномалий: ${anomalies.length}`);

// Группировка по типам
const anomalyTypes = {};
anomalies.forEach(a => {
    anomalyTypes[a.AnomalyType] = (anomalyTypes[a.AnomalyType] || 0) + 1;
});

console.log('\nРаспределение по типам:');
Object.entries(anomalyTypes)
    .sort((a, b) => b[1] - a[1])
    .forEach(([type, count]) => {
        console.log(`  ${type}: ${count}`);
    });

// Сохранение результатов
const csvOutput = ['ProcessInstanceId,AnomalyType,Explanation'];
anomalies.forEach(a => {
    const explanation = a.Explanation.includes(',') || a.Explanation.includes('"')
        ? `"${a.Explanation.replace(/"/g, '""')}"`
        : a.Explanation;
    csvOutput.push(`${a.ProcessInstanceId},${a.AnomalyType},${explanation}`);
});

fs.writeFileSync('anomalies.csv', csvOutput.join('\n'), 'utf-8');

console.log(`\n✓ Результаты сохранены в 'anomalies.csv'`);
console.log(`✓ Найдено ${new Set(anomalies.map(a => a.ProcessInstanceId)).size} процессов с аномалиями`);

// Примеры
console.log('\n' + '='.repeat(60));
console.log('ПРИМЕРЫ НАЙДЕННЫХ АНОМАЛИЙ');
console.log('='.repeat(60));

Object.keys(anomalyTypes)
    .sort((a, b) => anomalyTypes[b] - anomalyTypes[a])
    .slice(0, 5)
    .forEach(type => {
        console.log(`\n${type}:`);
        anomalies.filter(a => a.AnomalyType === type)
            .slice(0, 2)
            .forEach(a => {
                console.log(`  • ${a.ProcessInstanceId.substring(0, 8)}...: ${a.Explanation}`);
            });
    });

console.log('\n' + '='.repeat(60));
console.log('АНАЛИЗ ЗАВЕРШЁН');
console.log('='.repeat(60));
