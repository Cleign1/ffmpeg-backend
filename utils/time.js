export const getZonedDateParts = (date, timeZone) => {
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });

  const parts = formatter.formatToParts(date).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});

  const dateStr = `${parts.year}-${parts.month}-${parts.day}`;

  return {
    dateStr,
    hourStr: parts.hour,
    minuteStr: parts.minute,
    secondStr: parts.second
  };
};

export const getZonedTimestamp = (date, timeZone) => {
  const { dateStr, hourStr, minuteStr, secondStr } = getZonedDateParts(date, timeZone);
  return `${dateStr}-${hourStr}-${minuteStr}-${secondStr}`;
};
