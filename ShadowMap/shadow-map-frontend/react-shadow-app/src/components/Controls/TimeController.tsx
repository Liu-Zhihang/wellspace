import React, { useState, useEffect, useRef } from 'react';
import { useShadowMapStore } from '../../store/shadowMapStore';
import { DatePicker, Button, Row, Col, Tooltip, Popover, Slider } from 'antd';
import { PlayCircleOutlined, PauseCircleOutlined, BackwardOutlined, ForwardOutlined, SettingOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';

export const TimeController: React.FC = () => {
  const { currentDate, setCurrentDate } = useShadowMapStore();
  const [isPlaying, setIsPlaying] = useState(false);
  const [playSpeed, setPlaySpeed] = useState(1); // 1 hour per second
  const intervalRef = useRef<number | null>(null);

  const handleDateChange = (date: dayjs.Dayjs | null) => {
    if (date) {
      setCurrentDate(date.toDate());
    }
  };

  const togglePlayback = () => {
    if (isPlaying) {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      setIsPlaying(false);
    } else {
      setIsPlaying(true);
      intervalRef.current = window.setInterval(() => {
        const newDate = dayjs(currentDate).add(playSpeed, 'hour');
        setCurrentDate(newDate.toDate());
      }, 1000);
    }
  };
  
  useEffect(() => {
    // Cleanup on unmount
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, []);

  const adjustTime = (hours: number) => {
    const newDate = dayjs(currentDate).add(hours, 'hour');
    setCurrentDate(newDate.toDate());
  };

  const setPresetTime = (hour: number) => {
    const newDate = dayjs(currentDate).hour(hour).minute(0).second(0);
    setCurrentDate(newDate.toDate());
  };

  const speedMarks = {
    1: '1x',
    6: '6x',
    12: '12x',
    24: '24x',
  };

  const speedControl = (
    <div style={{ width: 150 }}>
      <Slider
        min={1}
        max={24}
        marks={speedMarks}
        step={null}
        value={playSpeed}
        onChange={setPlaySpeed}
        tooltip={{ formatter: (value) => `${value}x Speed` }}
      />
    </div>
  );

  return (
    <div className="space-y-4">
      <div>
        <label className="text-sm font-medium text-gray-600 mb-1 block">Date & Time</label>
        <DatePicker
          showTime
          value={dayjs(currentDate)}
          onChange={handleDateChange}
          style={{ width: '100%' }}
          size="large"
        />
      </div>

      <Row gutter={8}>
        <Col span={8}><Button block onClick={() => setPresetTime(6)}>🌅 Sunrise</Button></Col>
        <Col span={8}><Button block onClick={() => setPresetTime(12)}>☀️ Noon</Button></Col>
        <Col span={8}><Button block onClick={() => setPresetTime(18)}>🌇 Sunset</Button></Col>
      </Row>

      <div className="bg-gray-50 p-2 rounded-lg">
        <Row align="middle" justify="center" gutter={8}>
          <Col>
            <Tooltip title="Rewind 1 Hour">
              <Button icon={<BackwardOutlined />} onClick={() => adjustTime(-1)} />
            </Tooltip>
          </Col>
          <Col>
            <Tooltip title={isPlaying ? 'Pause' : 'Play'}>
              <Button
                type="primary"
                shape="circle"
                icon={isPlaying ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
                onClick={togglePlayback}
                size="large"
              />
            </Tooltip>
          </Col>
          <Col>
            <Tooltip title="Forward 1 Hour">
              <Button icon={<ForwardOutlined />} onClick={() => adjustTime(1)} />
            </Tooltip>
          </Col>
          <Col>
            <Popover content={speedControl} title="Playback Speed" trigger="click">
              <Button icon={<SettingOutlined />} />
            </Popover>
          </Col>
        </Row>
      </div>
    </div>
  );
};
